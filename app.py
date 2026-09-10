from flask import Flask, render_template, request, jsonify
from datetime import datetime

app = Flask(__name__)

# In-memory incident storage
incident_records = []

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/alert', methods=['POST'])
def handle_alert():
    data = request.get_json() or {}
    alert_type = data.get('type', 'UNKNOWN')
    detail = data.get('detail', '')

    record = {
        'id': len(incident_records) + 1,
        'type': alert_type,
        'detail': detail,
        'timestamp': datetime.now().strftime('%H:%M:%S')
    }
    incident_records.append(record)
    return jsonify({'status': 'success', 'record': record})

@app.route('/api/clear', methods=['POST'])
def clear_alerts():
    incident_records.clear()
    return jsonify({'status': 'success', 'count': 0})

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8080, debug=True)