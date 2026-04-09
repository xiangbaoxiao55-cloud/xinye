#!/usr/bin/env python3
"""
OpenAI (ChatGPT) 导出格式 → 千问 (Qwen) 导入格式 转换器
用法：python openai_to_qwen.py conversations.json output_qwen.json
"""

import json
import uuid
import sys
import os


def convert_message(msg_id, node, parent_id, children_ids, timestamp):
    """把ChatGPT单条消息转成千问格式"""
    message = node.get("message")
    if not message:
        return None

    role = message.get("author", {}).get("role", "")
    if role not in ("user", "assistant"):
        return None  # 跳过system/tool消息

    # 提取文本内容
    content_obj = message.get("content", {})
    content_type = content_obj.get("content_type", "")
    parts = content_obj.get("parts", [])
    content = ""
    if content_type == "text":
        content = "\n".join(p for p in parts if isinstance(p, str))
    elif content_type == "multimodal_text":
        content = "\n".join(p for p in parts if isinstance(p, str))

    if not content.strip():
        return None

    create_time = message.get("create_time") or timestamp

    return {
        "id": msg_id,
        "role": role,
        "content": content,
        "models": ["qwen-max"],
        "chat_type": "t2t",
        "sub_chat_type": "t2t",
        "edited": False,
        "error": None,
        "extra": {"meta": {"subChatType": "t2t"}},
        "feature_config": {
            "thinking_enabled": False,
            "output_schema": "phase",
            "instructions": None,
            "research_mode": "advance"
        },
        "parentId": parent_id,
        "turn_id": None,
        "childrenIds": children_ids,
        "files": [],
        "timestamp": int(create_time) if create_time else 0
    }


def convert_conversation(conv):
    """把一个ChatGPT对话转成千问对话格式"""
    title = conv.get("title", "导入的对话")
    mapping = conv.get("mapping", {})
    create_time = conv.get("create_time", 0)

    messages = {}

    for node_id, node in mapping.items():
        msg = node.get("message")
        if not msg:
            continue

        parent_id = node.get("parent")
        children_ids = node.get("children", [])

        # 过滤掉指向非user/assistant消息的parent/children
        converted = convert_message(
            node_id,
            node,
            parent_id,
            children_ids,
            create_time
        )
        if converted:
            messages[node_id] = converted

    # 修正parentId和childrenIds，去掉不存在的引用
    for msg_id, msg in messages.items():
        if msg["parentId"] not in messages:
            msg["parentId"] = None
        msg["childrenIds"] = [c for c in msg["childrenIds"] if c in messages]

    if not messages:
        return None

    conv_id = conv.get("id") or str(uuid.uuid4())
    return {
        "id": conv_id,
        "user_id": "imported",
        "title": title,
        "chat": {
            "history": {
                "messages": messages
            }
        }
    }


def main():
    if len(sys.argv) < 3:
        print("用法: python openai_to_qwen.py <输入文件> <输出文件>")
        print("示例: python openai_to_qwen.py conversations.json qwen_import.json")
        sys.exit(1)

    input_file = sys.argv[1]
    output_file = sys.argv[2]

    print(f"读取文件: {input_file} ...")
    with open(input_file, "r", encoding="utf-8") as f:
        data = json.load(f)

    if not isinstance(data, list):
        print("错误：输入文件格式不对，应该是对话列表")
        sys.exit(1)

    print(f"共 {len(data)} 个对话，开始转换...")

    result_data = []
    skipped = 0
    for i, conv in enumerate(data):
        converted = convert_conversation(conv)
        if converted:
            result_data.append(converted)
        else:
            skipped += 1
        if (i + 1) % 100 == 0:
            print(f"  已处理 {i + 1}/{len(data)}...")

    output = {
        "success": True,
        "request_id": str(uuid.uuid4()),
        "data": result_data
    }

    print(f"写入输出文件: {output_file} ...")
    with open(output_file, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(f"完成！转换了 {len(result_data)} 个对话，跳过 {skipped} 个空对话。")
    print(f"输出文件：{os.path.abspath(output_file)}")


if __name__ == "__main__":
    main()
