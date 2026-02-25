#!/bin/bash


curl -v -X POST http://localhost:62000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "minirag",
    "messages": [
      {"role": "user", "content": "你好,你当前在什么目录下,你是什么模型"}
    ]
  }'

