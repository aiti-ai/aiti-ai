#!/usr/bin/env python3
"""e2e-mybatis helper：发 /api/xml 请求（避免 bash 多层转义）
用法: python3 e2e-mybatis-helper.py <port> <mapper> <xml-file>
"""
import json, sys, urllib.request

port, mapper, xml_file = sys.argv[1], sys.argv[2], sys.argv[3]
xml_content = open(xml_file).read()
req = urllib.request.Request(
    f"http://127.0.0.1:{port}/api/xml",
    data=json.dumps({"mapper": mapper, "content": xml_content}).encode(),
    headers={"Content-Type": "application/json"},
)
print(urllib.request.urlopen(req).read().decode())
