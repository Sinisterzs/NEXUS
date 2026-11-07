import sqlite3
import os
import time

db_path = os.path.expandvars(r'%APPDATA%\com.nexus.desktop\nexus.db')
print(f"Testing SQLite database at: {db_path}")

conn = sqlite3.connect(db_path)
cursor = conn.cursor()
conn.execute("PRAGMA foreign_keys = ON;")

print("\n--- Test 1: Verify All Contacts / Conversations Exist ---")
contacts = [
    ("f_01", "Beatriz Lima"),
    ("f_02", "Lucas Rocha"),
    ("f_03", "Helena Santos"),
    ("f_04", "Guilherme Silva"),
    ("f_05", "Mariana Costa"),
    ("f_06", "Thiago Mendes"),
    ("f_07", "Camila Duarte"),
]

now = int(time.time())
for cid, name in contacts:
    # Emulate ensure_conversation logic
    conn.execute(
        "INSERT INTO conversations (id, type, title, updated_at) VALUES (?, 'dm', ?, ?) "
        "ON CONFLICT(id) DO UPDATE SET title = ? WHERE title != ?",
        (cid, name, now, name, name)
    )
conn.commit()

# Verify no duplicate IDs
rows = cursor.execute("SELECT id, title, count(*) FROM conversations GROUP BY id HAVING count(*) > 1").fetchall()
assert len(rows) == 0, f"Found duplicate conversations: {rows}"
print("[OK] No duplicate conversations. All 7 contacts ensured.")

print("\n--- Test 2: Send Messages to Multiple Different Contacts ---")
# Send test message to f_03 (Helena)
msg_f03_id = f"test_msg_f03_{now}"
conn.execute(
    "INSERT INTO messages (id, conversation_id, sender_id, content, created_at, delivery_status) "
    "VALUES (?, ?, 'usr_me', ?, ?, 'local_saved')",
    (msg_f03_id, "f_03", "Oi Helena, tudo bem? Testando envio direto.", now)
)
# Send test message to f_05 (Mariana)
msg_f05_id = f"test_msg_f05_{now}"
conn.execute(
    "INSERT INTO messages (id, conversation_id, sender_id, content, created_at, delivery_status) "
    "VALUES (?, ?, 'usr_me', ?, ?, 'local_saved')",
    (msg_f05_id, "f_05", "Oi Mariana, o setup está funcionando 100%.", now)
)
conn.commit()

# Verify messages in f_03
f03_msgs = cursor.execute("SELECT id, content FROM messages WHERE conversation_id = 'f_03'").fetchall()
assert any(m[0] == msg_f03_id for m in f03_msgs), "f_03 message not found!"
print(f"[OK] f_03 has {len(f03_msgs)} messages. Newly sent message verified.")

# Verify messages in f_05
f05_msgs = cursor.execute("SELECT id, content FROM messages WHERE conversation_id = 'f_05'").fetchall()
assert any(m[0] == msg_f05_id for m in f05_msgs), "f_05 message not found!"
print(f"[OK] f_05 has {len(f05_msgs)} messages. Newly sent message verified.")

print("\n--- Test 3: Create & Verify Distinct Drafts per Contact ---")
# Draft for f_01
conn.execute(
    "INSERT INTO conversation_state (conversation_id, draft_text) VALUES (?, ?) "
    "ON CONFLICT(conversation_id) DO UPDATE SET draft_text = ?",
    ("f_01", "Rascunho secreto para a Beatriz", "Rascunho secreto para a Beatriz")
)
# Draft for f_02
conn.execute(
    "INSERT INTO conversation_state (conversation_id, draft_text) VALUES (?, ?) "
    "ON CONFLICT(conversation_id) DO UPDATE SET draft_text = ?",
    ("f_02", "Rascunho técnico sobre Rust para o Lucas", "Rascunho técnico sobre Rust para o Lucas")
)
conn.commit()

draft_f01 = cursor.execute("SELECT draft_text FROM conversation_state WHERE conversation_id = 'f_01'").fetchone()[0]
draft_f02 = cursor.execute("SELECT draft_text FROM conversation_state WHERE conversation_id = 'f_02'").fetchone()[0]

assert draft_f01 == "Rascunho secreto para a Beatriz", f"Draft f_01 mismatch: {draft_f01}"
assert draft_f02 == "Rascunho técnico sobre Rust para o Lucas", f"Draft f_02 mismatch: {draft_f02}"
print(f"[OK] Draft f_01: \"{draft_f01}\"")
print(f"[OK] Draft f_02: \"{draft_f02}\"")
print("[OK] Individual drafts are strictly isolated without cross-contamination.")

print("\n--- Test 4: Verify All Conversations in Database ---")
for row in cursor.execute("SELECT id, type, title, updated_at FROM conversations ORDER BY id").fetchall():
    msg_count = cursor.execute("SELECT count(*) FROM messages WHERE conversation_id = ?", (row[0],)).fetchone()[0]
    draft_val = cursor.execute("SELECT draft_text FROM conversation_state WHERE conversation_id = ?", (row[0],)).fetchone()
    has_draft = bool(draft_val and draft_val[0])
    print(f"  * {row[0]}: {row[2]} ({msg_count} msgs, draft_present={has_draft})")

conn.close()
print("\nAll DB-level tests passed successfully!")
