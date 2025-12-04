import express from 'express';
import cors from 'cors';
import mqtt from 'mqtt';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { mqttConfig } from './config.js';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

// --- CẤU HÌNH ĐƯỜNG DẪN CHO ES MODULES ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

// Create HTTP server and Socket.IO instance
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// MQTT client
let mqttClient = null;

// Middleware
app.use(cors());
app.use(express.json());

// In-memory storage for sensor data
// (Đã thêm trường 'light' cho phù hợp model AI)
let sensorData = {
  temp: 24,
  hum: 66,
  soil: 60,
  level: 56,
  flow: 0,
  timestamp: Date.now()
};

// System state
let systemState = {
  pumpOn: false,
  mode: 'automatic', // 'automatic', 'manual', 'ai'
  pumpStartTime: null,
  pumpDuration: 0, 
  lastCommand: null,
  lastCommandTime: null
};

// --- AI INTEGRATION FUNCTION ---
function askPythonAI(temp, hum, soil) {
  return new Promise((resolve, reject) => {
    // Đường dẫn tới file Python (giả sử nằm cùng thư mục với server.js)
    const pythonScript = path.join(__dirname, 'ai_service.py');
    
    // Gọi lệnh python
    // Lưu ý: Nếu máy bạn dùng 'python3' thì đổi chữ 'python' bên dưới thành 'python3'
    const pythonProcess = spawn('python', [
      pythonScript, 
      temp, 
      hum, 
      soil, 
    ]);

    let dataString = '';

    pythonProcess.stdout.on('data', (data) => {
      dataString += data.toString();
    });

    pythonProcess.stderr.on('data', (data) => {
      console.error(`AI Error: ${data}`);
    });

    pythonProcess.on('close', (code) => {
      try {
        // Parse kết quả JSON từ Python trả về
        const result = JSON.parse(dataString);
        resolve(result.action); // 1 (Bơm) hoặc 0 (Tắt)
      } catch (e) {
        console.error("Lỗi đọc data từ AI:", e);
        resolve(0); // Mặc định an toàn là tắt
      }
    });
  });
}

// --- ROUTES ---

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Smart Watering Backend is running' });
});

app.get('/api/sensors', (req, res) => {
  res.json(sensorData);
});

app.get('/api/status', (req, res) => {
  res.json({
    pumpOn: systemState.pumpOn,
    mode: systemState.mode,
    pumpStartTime: systemState.pumpStartTime,
    pumpDuration: systemState.pumpDuration,
    remainingTime: systemState.pumpOn && systemState.pumpStartTime
      ? Math.max(0, systemState.pumpDuration - (Date.now() - systemState.pumpStartTime))
      : 0,
    lastCommand: systemState.lastCommand,
    lastCommandTime: systemState.lastCommandTime
  });
});

app.get('/api/mode', (req, res) => {
  res.json({ mode: systemState.mode });
});

// Set mode
app.post('/api/mode', (req, res) => {
  const { mode } = req.body;
  
  // Cho phép thêm mode 'ai'
  if (!mode || !['automatic', 'manual', 'ai'].includes(mode)) {
    return res.status(400).json({ 
      error: 'Invalid mode. Must be "automatic", "manual" or "ai"' 
    });
  }
  
  systemState.mode = mode;
  console.log(`Mode changed to: ${mode}`);
  
  // Gửi lệnh xuống ESP32 (để nó biết đổi LED hiển thị chẳng hạn)
  publishCommand('set_mode', { mode: mode });
  
  // Nếu chuyển sang AI, tắt bơm ngay để AI tự quyết định lại từ đầu
  if (mode === 'ai' && systemState.pumpOn) {
     stopPumpInternal('mode_change');
  }
  
  io.emit('mode_update', { mode: systemState.mode });
  
  res.json({ 
    success: true, 
    mode: systemState.mode,
    message: `Mode set to ${mode}` 
  });
});

app.post('/api/pump/start', (req, res) => {
  const { duration } = req.body;
  
  // Manual start không hoạt động ở chế độ AI (để tránh xung đột)
  if (systemState.mode === 'ai') {
    return res.status(400).json({ 
      error: 'Cannot manually start pump in AI mode' 
    });
  }

  if (systemState.pumpOn) {
    return res.status(400).json({ 
      error: 'Pump is already running',
      currentState: systemState 
    });
  }
  
  startPumpInternal(duration, 'manual_api');
  
  res.json({ 
    success: true, 
    message: 'Pump started',
    mode: systemState.mode
  });
});

app.post('/api/pump/stop', (req, res) => {
  if (!systemState.pumpOn) {
    return res.status(400).json({ 
      error: 'Pump is not running',
      currentState: systemState 
    });
  }
  
  stopPumpInternal('manual_api');
  
  res.json({ 
    success: true, 
    message: 'Pump stopped'
  });
});

// --- HELPER FUNCTIONS ---

// Hàm bật bơm nội bộ (dùng chung cho API và AI)
function startPumpInternal(durationSec = 10, reason = 'unknown') {
  const durationMs = durationSec * 1000;
  
  systemState.pumpOn = true;
  systemState.pumpStartTime = Date.now();
  systemState.pumpDuration = durationMs;
  systemState.lastCommand = 'start';
  systemState.lastCommandTime = Date.now();
  
  console.log(`[${reason}] Pump started. Duration: ${durationMs}ms`);
  
  publishCommand('pump_start', { 
    duration: durationSec,
    durationMs: durationMs,
    mode: systemState.mode 
  });
  
  emitSystemState();

  // Auto-stop timeout (chỉ áp dụng cho Manual/Auto, AI tự quản lý loop)
  if (systemState.mode !== 'ai') {
    setTimeout(() => {
      if (systemState.pumpOn && systemState.mode !== 'ai') {
        stopPumpInternal('auto_timeout');
      }
    }, durationMs);
  }
}

// Hàm tắt bơm nội bộ
function stopPumpInternal(reason = 'unknown') {
  const runTime = systemState.pumpStartTime 
    ? Date.now() - systemState.pumpStartTime 
    : 0;
  
  systemState.pumpOn = false;
  systemState.pumpStartTime = null;
  systemState.pumpDuration = 0;
  systemState.lastCommand = 'stop';
  systemState.lastCommandTime = Date.now();
  
  console.log(`[${reason}] Pump stopped. Run time: ${runTime}ms`);
  
  publishCommand('pump_stop', { runTime: runTime, reason: reason });
  
  emitSystemState();
}

function emitSystemState() {
  const status = {
    pumpOn: systemState.pumpOn,
    mode: systemState.mode,
    pumpStartTime: systemState.pumpStartTime,
    pumpDuration: systemState.pumpDuration,
    remainingTime: systemState.pumpOn && systemState.pumpStartTime
      ? Math.max(0, systemState.pumpDuration - (Date.now() - systemState.pumpStartTime))
      : 0,
    lastCommand: systemState.lastCommand,
    lastCommandTime: systemState.lastCommandTime
  };
  
  io.emit('status_update', status);
}

function publishCommand(command, data = {}) {
  if (!mqttClient || !mqttClient.connected) {
    // console.error('MQTT client not connected'); // Bỏ bớt log lỗi để đỡ spam
    return false;
  }

  const commandMessage = {
    command: command,
    timestamp: Date.now(),
    ...data
  };

  const topic = mqttConfig.topics.command;
  const message = JSON.stringify(commandMessage);

  mqttClient.publish(topic, message, { qos: 1 });
  return true;
}

function connectMQTT() {
  try {
    console.log(`Connecting to MQTT broker: ${mqttConfig.brokerUrl}`);
    mqttClient = mqtt.connect(mqttConfig.brokerUrl, mqttConfig.options);

    mqttClient.on('connect', () => {
      console.log('Connected to MQTT broker');
      mqttClient.subscribe(mqttConfig.topics.data);
    });

    mqttClient.on('message', async (topic, message) => {
      if (topic === mqttConfig.topics.data) {
        try {
          const data = JSON.parse(message.toString());
          
          // Cập nhật sensorData
          sensorData = {
            temp: data.temp || data.temperature || sensorData.temp,
            hum: data.hum || data.humidity || sensorData.hum,
            soil: data.soil || data.soilMoisture || sensorData.soil,
            level: data.level || data.waterLevel || sensorData.level,
            flow: data.flow || data.flowRate || sensorData.flow,
            light: data.light || data.lux || sensorData.light, // Thêm Light
            timestamp: Date.now()
          };
          
          io.emit('sensor_update', sensorData);

          // --- LOGIC AI ---
          if (systemState.mode === 'ai') {
             // Gọi Python AI
             const action = await askPythonAI(
               sensorData.temp, 
               sensorData.hum, 
               sensorData.soil, 
             );

             console.log(`>>> AI Decision: ${action === 1 ? 'WATER' : 'WAIT'} (Soil: ${sensorData.soil}, Temp: ${sensorData.temp})`);

             if (action === 1 && !systemState.pumpOn) {
                // Bơm 10 giây rồi AI sẽ check lại ở lần gửi data tiếp theo
                startPumpInternal(10, 'ai_trigger'); 
             } else if (action === 0 && systemState.pumpOn) {
                // Nếu AI bảo dừng mà bơm đang chạy -> Tắt
                stopPumpInternal('ai_trigger');
             }
          } 
          // Logic Auto cũ vẫn giữ nguyên hoặc xử lý riêng
          // else if (systemState.mode === 'automatic') { ... }

        } catch (error) {
          console.error('Error handling MQTT message:', error);
        }
      }
    });
  } catch (error) {
    console.error('Failed to initialize MQTT client:', error.message);
  }
}

io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);
  socket.emit('sensor_update', sensorData);
  emitSystemState();
  
  socket.on('get_sensors', () => socket.emit('sensor_update', sensorData));
  socket.on('get_status', () => emitSystemState());
});

httpServer.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
  connectMQTT();
});