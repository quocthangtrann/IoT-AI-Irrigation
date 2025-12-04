import sys
import joblib
import pandas as pd
import json

# 1. Load model 
try:
    model = joblib.load('/Users/leuyentran/Documents/DATKLL/DA_TKLL-dev/backend/model_tuoi_cay.pkl')
except:
    print(json.dumps({"action": 0, "error": "No model found"}))
    sys.exit(0)


try:
    temp = float(sys.argv[1])
    humid = float(sys.argv[2])
    soil = float(sys.argv[3])

    input_data = pd.DataFrame([[temp, humid, soil]], 
                              columns=['temp', 'hum', 'soil'])

    # 3. Dự đoán
    prediction = model.predict(input_data)
    
    # 4. Trả kết quả về cho Node.js (dạng JSON)
    result = {
        "action": int(prediction[0]), 
        "reason": "AI Model Decision"
    }
    print(json.dumps(result)) 

except Exception as e:
    print(json.dumps({"action": 0, "error": str(e)}))