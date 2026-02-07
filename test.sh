#!/bin/bash


curl -v -X POST http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "minirag",
    "messages": [
      {"role": "user", "content": "你好"}
    ]
  }'

