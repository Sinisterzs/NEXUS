import sqlite3, os
db_path = os.path.expandvars(r'%APPDATA%\com.nexus.desktop\nexus.db')
conn = sqlite3.connect(db_path)
conn.execute('PRAGMA foreign_keys = ON;')
try:
    conn.execute('INSERT INTO messages (id, conversation_id, sender_id, content, created_at, delivery_status) VALUES (?, ?, ?, ?, ?, ?)',
                 ('test_1', 'f_03', 'usr_me', 'hello', 12345, 'local_saved'))
    print("SUCCESS")
except Exception as e:
    print("EXPECTED ERROR:", type(e).__name__, e)
