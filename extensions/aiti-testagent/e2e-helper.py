#!/usr/bin/env python3
"""e2e 通用 helper：发 /api/<api> 请求（JSON 从文件读，避免 bash 多层转义）
用法: python3 e2e-helper.py <port> <api> <json-file> [DELETE]
"""
import json, sys, urllib.request

port, api, json_file = sys.argv[1], sys.argv[2], sys.argv[3]
method = "DELETE" if len(sys.argv) > 4 and sys.argv[4] == "DELETE" else "POST"
body = json.load(open(json_file))
req = urllib.request.Request(
    f"http://127.0.0.1:{port}/api/{api}",
    data=json.dumps(body).encode() if method == "POST" else None,
    headers={"Content-Type": "application/json"},
    method=method,
)
print(urllib.request.urlopen(req).read().decode())
