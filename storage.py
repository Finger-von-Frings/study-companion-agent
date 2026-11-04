"""SQLite persistence. Every query is scoped to the local browser profile."""
import hashlib
import json
import secrets
import sqlite3
import time
from contextlib import contextmanager

SCHEMA = """
CREATE TABLE IF NOT EXISTS profiles(id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS conversations(
 id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL, created REAL, updated REAL);
CREATE TABLE IF NOT EXISTS turns(
 id INTEGER PRIMARY KEY, conversation TEXT, question TEXT, response TEXT);
CREATE TABLE IF NOT EXISTS quizzes(
 id TEXT PRIMARY KEY, owner TEXT, conversation TEXT, payload TEXT, result TEXT, created REAL);
CREATE TABLE IF NOT EXISTS mistakes(
 id TEXT, owner TEXT, question TEXT, selected INTEGER, wrong_count INTEGER, mastered INTEGER,
 updated REAL, PRIMARY KEY(id, owner));
CREATE TABLE IF NOT EXISTS documents(
 id TEXT PRIMARY KEY, owner TEXT, title TEXT, filename TEXT, content TEXT, created REAL);
CREATE TABLE IF NOT EXISTS review_schedule(
 id TEXT, owner TEXT, streak INTEGER NOT NULL, due REAL NOT NULL, reviewed REAL,
 PRIMARY KEY(id,owner));
CREATE TABLE IF NOT EXISTS conversation_settings(
 conversation TEXT PRIMARY KEY, mode TEXT NOT NULL, document_id TEXT);
CREATE INDEX IF NOT EXISTS idx_conversations_owner ON conversations(owner,updated);
CREATE INDEX IF NOT EXISTS idx_turns_conversation ON turns(conversation);
CREATE INDEX IF NOT EXISTS idx_quizzes_owner ON quizzes(owner);
"""


class Store:
    def __init__(self, directory):
        directory.mkdir(parents=True, exist_ok=True)
        self.path = directory / "study.db"
        with self.connect() as db:
            db.executescript(SCHEMA)
            db.execute("""INSERT OR IGNORE INTO review_schedule
                SELECT id,owner,CASE WHEN mastered=1 THEN 1 ELSE 0 END,
                updated + CASE WHEN mastered=1 THEN 86400 ELSE 0 END,updated FROM mistakes""")

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=15)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def profile(self, token):
        with self.connect() as db:
            if not token or not db.execute("SELECT 1 FROM profiles WHERE id=?", (token,)).fetchone():
                token = secrets.token_hex(16)
                db.execute("INSERT INTO profiles VALUES (?)", (token,))
        return token

    def create_conversation(self, owner, title="新的学习"):
        cid = secrets.token_hex(16)
        with self.connect() as db:
            db.execute("INSERT INTO conversations VALUES (?,?,?,?,?)", (cid, owner, title, time.time(), time.time()))
        return cid

    def require_conversation(self, db, owner, cid):
        row = db.execute("SELECT * FROM conversations WHERE id=? AND owner=?", (cid, owner)).fetchone()
        if not row:
            raise ValueError("找不到当前学习记录")
        return dict(row)

    def conversations(self, owner):
        with self.connect() as db:
            return [dict(row) for row in db.execute(
                "SELECT * FROM conversations WHERE owner=? ORDER BY updated DESC LIMIT 100", (owner,))]

    def conversation(self, owner, cid):
        with self.connect() as db:
            result = self.require_conversation(db, owner, cid)
            setting = db.execute("SELECT mode,document_id FROM conversation_settings WHERE conversation=?", (cid,)).fetchone()
            result["settings"] = dict(setting) if setting else {"mode": "explain", "document_id": None}
            result["turns"] = []
            for row in db.execute("SELECT * FROM turns WHERE conversation=? ORDER BY id", (cid,)):
                reply = json.loads(row["response"])
                for quiz in reply.get("quizzes", []):
                    grade = db.execute("SELECT result FROM quizzes WHERE id=? AND owner=?", (quiz["id"], owner)).fetchone()
                    if grade and grade["result"]:
                        quiz["grade"] = json.loads(grade["result"])
                result["turns"].append({"question": row["question"], "response": reply})
            return result

    def commit_turn(self, owner, cid, question, response):
        with self.connect() as db:
            self.require_conversation(db, owner, cid)
            empty = not db.execute("SELECT 1 FROM turns WHERE conversation=?", (cid,)).fetchone()
            db.execute("INSERT INTO turns(conversation,question,response) VALUES (?,?,?)",
                       (cid, question, json.dumps(response, ensure_ascii=False)))
            db.execute("UPDATE conversations SET updated=? WHERE id=?", (time.time(), cid))
            if empty:
                db.execute("UPDATE conversations SET title=? WHERE id=?", (question[:32], cid))

    def delete_conversation(self, owner, cid):
        # Quiz results and mistakes are kept so statistics and review are unaffected.
        with self.connect() as db:
            self.require_conversation(db, owner, cid)
            db.execute("DELETE FROM turns WHERE conversation=?", (cid,))
            db.execute("DELETE FROM conversation_settings WHERE conversation=?", (cid,))
            db.execute("DELETE FROM conversations WHERE id=? AND owner=?", (cid, owner))

    def set_settings(self, owner, cid, mode, document_id):
        with self.connect() as db:
            self.require_conversation(db, owner, cid)
            db.execute("INSERT OR REPLACE INTO conversation_settings VALUES (?,?,?)", (cid,mode,document_id))

    def register_quiz(self, owner, cid, quiz):
        with self.connect() as db:
            self.require_conversation(db, owner, cid)
            db.execute("INSERT OR IGNORE INTO quizzes VALUES (?,?,?,?,NULL,?)",
                       (quiz["id"], owner, cid, json.dumps(quiz, ensure_ascii=False), time.time()))

    def get_quiz(self, owner, quiz_id):
        with self.connect() as db:
            row = db.execute("SELECT * FROM quizzes WHERE owner=? AND id=?", (owner, quiz_id)).fetchone()
            if not row:
                raise ValueError("练习不属于当前学习档案")
            return json.loads(row["payload"])

    @staticmethod
    def question_key(q):
        # Stable across retries; explanations may vary but question/answer identity remains.
        raw = json.dumps([q["question"], q["options"], q["answer"], q["source_id"]], ensure_ascii=False)
        return hashlib.sha256(raw.encode()).hexdigest()

    def record_grade(self, owner, quiz, result):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT result FROM quizzes WHERE id=? AND owner=?", (quiz["id"], owner)).fetchone()
            if not row:
                raise ValueError("练习不属于当前学习档案")
            if row["result"]:
                return json.loads(row["result"])
            db.execute("UPDATE quizzes SET result=? WHERE id=? AND owner=?",
                       (json.dumps(result, ensure_ascii=False), quiz["id"], owner))
            now = time.time()
            for q, answer in zip(quiz["questions"], result["results"]):
                key = self.question_key(q)
                schedule = db.execute("SELECT * FROM review_schedule WHERE id=? AND owner=?", (key,owner)).fetchone()
                if answer["correct"]:
                    if schedule:
                        # Early repeats do not advance the schedule; a due review does.
                        if now >= schedule["due"]:
                            streak = min(schedule["streak"] + 1, 5)
                            days = (1,3,7,14,30)[streak-1]
                            db.execute("UPDATE review_schedule SET streak=?,due=?,reviewed=? WHERE id=? AND owner=?",
                                       (streak, now+days*86400,now,key,owner))
                    db.execute("UPDATE mistakes SET mastered=1,updated=? WHERE id=? AND owner=?", (time.time(), key, owner))
                else:
                    db.execute("INSERT OR REPLACE INTO review_schedule VALUES (?,?,0,?,?)", (key,owner,now,now))
                    db.execute("""INSERT INTO mistakes VALUES (?,?,?,?,1,0,?)
                    ON CONFLICT(id,owner) DO UPDATE SET selected=excluded.selected,
                    wrong_count=mistakes.wrong_count+1,mastered=0,updated=excluded.updated""",
                               (key, owner, json.dumps(q, ensure_ascii=False), answer["selected"], time.time()))
            return result

    def mistakes(self, owner):
        with self.connect() as db:
            rows = [dict(row) for row in db.execute(
                "SELECT * FROM mistakes WHERE owner=? ORDER BY mastered,updated DESC", (owner,))]
            schedules = {r["id"]: dict(r) for r in db.execute("SELECT * FROM review_schedule WHERE owner=?", (owner,))}
        now = time.time()
        for row in rows:
            schedule = schedules.get(row["id"], {"due": row["updated"], "streak": 0})
            row["due"] = schedule["due"]
            row["streak"] = schedule["streak"]
            row["is_due"] = schedule["due"] <= now
            row["review_status"] = "due" if row["is_due"] else "consolidating"
            row["question"] = json.loads(row["question"])
            row.pop("owner")
        return rows

    def stats(self, owner):
        with self.connect() as db:
            grades = [json.loads(row["result"]) for row in db.execute(
                "SELECT result FROM quizzes WHERE owner=? AND result IS NOT NULL", (owner,))]
        total = sum(g["total"] for g in grades)
        correct = sum(g["score"] for g in grades)
        topics = {}
        for grade in grades:
            for r in grade["results"]:
                topic = r["source_id"].split("::")[0]
                item = topics.setdefault(topic, {"id": topic, "total": 0, "correct": 0})
                item["total"] += 1
                item["correct"] += int(r["correct"])
        return {"attempts": len(grades), "total": total, "correct": correct,
                "accuracy": round(correct / total * 100) if total else None,
                "pending": sum(m["is_due"] for m in self.mistakes(owner)),
                "topics": list(topics.values())}

    def documents(self, owner):
        with self.connect() as db:
            return [{"id": r["id"], "title": r["title"], "file": r["filename"],
                     "content": r["content"], "uploaded": True}
                    for r in db.execute("SELECT * FROM documents WHERE owner=? ORDER BY created DESC", (owner,))]

    def add_document(self, owner, filename, content):
        if (not isinstance(filename, str) or not filename.lower().endswith((".md", ".txt"))
                or len(filename) > 160 or "/" in filename or "\\" in filename):
            raise ValueError("仅支持文件名不超过160字的 Markdown / TXT 文件")
        if not isinstance(content, str) or not content.strip() or len(content.encode("utf-8")) > 200_000:
            raise ValueError("资料不能为空，且不能超过 200 KB")
        if "\x00" in content or "\ufffd" in content:
            raise ValueError("请使用 UTF-8 编码的文本文件")
        content = content.lstrip("\ufeff")
        title = next((line.lstrip("# ").strip() for line in content.splitlines() if line.strip()), filename)[:100]
        with self.connect() as db:
            count = db.execute("SELECT COUNT(*) FROM documents WHERE owner=?", (owner,)).fetchone()[0]
            if count >= 30:
                raise ValueError("当前学习档案最多上传 30 份资料")
            existing = db.execute("SELECT id FROM documents WHERE owner=? AND content=?", (owner, content)).fetchone()
            if existing:
                raise ValueError("这份资料已上传，无需重复添加")
            doc_id = "upload-" + secrets.token_hex(8)
            db.execute("INSERT INTO documents VALUES (?,?,?,?,?,?)",
                       (doc_id, owner, title, filename, content, time.time()))
        return doc_id

    def delete_document(self, owner, doc_id):
        with self.connect() as db:
            if not db.execute("DELETE FROM documents WHERE id=? AND owner=?", (doc_id, owner)).rowcount:
                raise ValueError("只能删除当前档案上传的资料")
            db.execute("""UPDATE conversation_settings SET document_id=NULL WHERE document_id=?
                AND conversation IN (SELECT id FROM conversations WHERE owner=?)""", (doc_id, owner))
