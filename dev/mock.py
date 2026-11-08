# Local stand-in for the Space Fast functions, key "test", for UI testing only.
import json, time, http.server, sys
ROOT = sys.argv[1]
DB = []
TAKES = []
KEYS = {"test"}
class H(http.server.SimpleHTTPRequestHandler):
    def __init__(s, *a, **k): super().__init__(*a, directory=ROOT, **k)
    def j(s, o, c=200):
        b = json.dumps(o).encode(); s.send_response(c); s.send_header("content-type","application/json"); s.end_headers(); s.wfile.write(b)
    def ok(s): return s.headers.get("authorization","").replace("Bearer ","") in KEYS
    def do_GET(s):
        if not s.path.startswith("/api/"): return super().do_GET()
        if not s.ok(): return s.j({"error":"bad key"},401)
        parts = s.path.split("?")[0].strip("/").split("/")
        if parts[1] == "takes": return s.j({"takes": TAKES}) if len(parts) == 2 else s.j({"take": next((t for t in TAKES if t["id"] == parts[2]), None)})
        if len(parts) == 2: return s.j({"scripts":[{k:v for k,v in d.items() if k!="body"} | {"chars":len(d["body"]),"preview":d["body"][:160]} for d in sorted(DB,key=lambda d:-d["created_at"])]})
        d = next((d for d in DB if d["id"]==parts[2]), None)
        return s.j({"script":d}) if d else s.j({"error":"nf"},404)
    def do_POST(s):
        if s.path == "/api/inboxes":
            import secrets; k = secrets.token_hex(16); KEYS.add(k); return s.j({"key": k}, 201)
        if not s.ok(): return s.j({"error":"bad key"},401)
        o = json.loads(s.rfile.read(int(s.headers["content-length"])))
        if s.path == "/api/takes":
            o["id"] = "t%d" % len(TAKES); TAKES.append(o); return s.j({"ok": True, "id": o["id"]}, 201)
        d = {"id":"m%d"%len(DB),"title":o.get("title","Untitled"),"source":o.get("source","grok"),"body":o["text"],"created_at":int(time.time()*1000),"updated_at":int(time.time()*1000)}
        DB.append(d); s.j({"ok":True,"id":d["id"]},201)
    def do_PUT(s):
        o = json.loads(s.rfile.read(int(s.headers.get("content-length", 0)) or 0) or b"{}")
        for t in TAKES:
            if s.path.endswith("/" + t["id"]): t.update(o)
        for d in DB:
            if s.path.endswith("/" + d["id"]):
                d["title"] = o.get("title", d["title"]); d["body"] = o.get("text", d["body"]); d["updated_at"] = int(time.time()*1000)
        s.j({"ok": True})
    def do_DELETE(s):
        TAKES[:] = [t for t in TAKES if not s.path.endswith("/" + t["id"])]
        s.j({"ok": True})
    def log_message(s,*a): pass
http.server.ThreadingHTTPServer(("127.0.0.1", 8765), H).serve_forever()
