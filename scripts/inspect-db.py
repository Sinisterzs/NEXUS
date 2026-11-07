import sqlite3
import os

db_path = os.path.expandvars(r'%APPDATA%\com.nexus.desktop\nexus.db')
print(f"Connecting to: {db_path}")

conn = sqlite3.connect(db_path)
cursor = conn.cursor()

print("\n--- Tables in SQLite ---")
for row in cursor.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"):
    print(f"  • {row[0]}")

print("\n--- Migrations Recorded ---")
for row in cursor.execute("SELECT version, applied_at FROM _migrations"):
    print(f"  • Version {row[0]} applied at timestamp {row[1]}")

print("\n--- Seeded Conversations ---")
for row in cursor.execute("SELECT id, type, title, updated_at FROM conversations"):
    print(f"  • [{row[1].upper()}] {row[0]}: \"{row[2]}\" (updated: {row[3]})")

print("\n--- Messages in DB ---")
for row in cursor.execute("SELECT id, conversation_id, sender_id, content, created_at, delivery_status FROM messages"):
    print(f"  • [{row[5]}] ({row[1]}) {row[2]}: {row[3]}")

print("\n--- Conversation State ---")
for row in cursor.execute("SELECT conversation_id, last_read_message_id, draft_text FROM conversation_state"):
    print(f"  • Conv {row[0]}: last_read={row[1]}, draft=\"{row[2]}\"")

print("\n--- Cache Metadata ---")
for row in cursor.execute("SELECT key, value, updated_at FROM cache_metadata"):
    print(f"  • {row[0]} = {row[1]} (updated: {row[2]})")

conn.close()
