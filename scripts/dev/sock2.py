import json,socket,sys
def call(msg):
    c=socket.socket(socket.AF_UNIX); c.settimeout(540); c.connect("/tmp/mc-dev.sock"); c.sendall((json.dumps(msg)+"\n").encode()); buf=b""
    while b"\n" not in buf: buf+=c.recv(65536)
    c.close(); return json.loads(buf)
if __name__=="__main__": print(json.dumps(call(json.loads(sys.argv[1]))))
