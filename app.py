from flask import Flask, render_template, jsonify, request
from datetime import datetime

app = Flask(__name__)

# Store alert logs in memory
incidents = []

@app.route("/")
def index():
    return render_template("index.html")

@app.route("/api/alert", methods=["POST"])
def log_alert():
    data = request.get_json() or {}
    record = {
        "id": len(incidents) + 1,
        "timestamp": datetime.now().strftime("%H:%M:%S"),
        "type": data.get("type", "DROWSINESS"),
        "detail": data.get("detail", "Eyes closed sustained")
    }
    incidents.insert(0, record)  # Keep latest at the top
    if len(incidents) > 50:
        incidents.pop()
    return jsonify({"status": "logged", "record": record, "total": len(incidents)}), 200

@app.route("/api/logs", methods=["GET"])
def get_logs():
    return jsonify(incidents), 200

@app.route("/api/clear", methods=["POST"])
def clear_logs():
    incidents.clear()
    return jsonify({"status": "cleared"}), 200

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080, debug=True)