"""Paragraph chunks + BM25-style term scoring, no embedding service required."""
import math
import re
from collections import Counter

STOP = {"什么", "怎么", "如何", "一下", "这个", "那个", "可以", "请问", "解释", "说明", "资料", "课程", "学习", "知识", "问题", "练习", "出题", "选择", "道题", "围绕", "帮我", "简单"}


def tokenize(text):
    text = text.lower()
    words = re.findall(r"[a-z][a-z0-9]*|/\d{1,2}|\d{2,}", text)
    for run in re.findall(r"[\u4e00-\u9fff]+", text):
        words.extend(run[i:i+2] for i in range(len(run)-1) if run[i:i+2] not in STOP)
    return words


ALIASES = {"域名解析": "dns", "传输控制协议": "tcp", "用户数据报协议": "udp",
           "超文本传输协议": "http", "安全超文本传输协议": "https", "网际协议": "ip",
           "三步握手": "三次握手", "子网掩码": "cidr"}


def chunks(doc, limit=700):
    content = doc["content"]
    headings = list(re.finditer(r"(?m)^#{1,6} +(.+)$", content))
    boundaries = sorted(set([0, len(content)] + [m.start() for m in headings]))
    spans = []
    for left, right in zip(boundaries, boundaries[1:]):
        start = left
        while start < right:
            end = min(start + limit, right)
            if end < right:
                cut = content.rfind("\n\n", start + limit // 3, end)
                if cut < 0:
                    cut = content.rfind("\n", start + limit // 2, end)
                if cut > start:
                    end = cut + 1
            if content[start:end].strip():
                section = next((m[1] for m in reversed(headings) if m.start() <= start), doc["title"])
                spans.append((start, end, section))
            start = end
    return [{**doc, "id": doc["id"] if i == 0 else doc["id"] + "::" + str(i+1),
             "doc_id": doc["id"], "chunk_index": i+1, "start": start, "end": end,
             "section": section, "content": content[start:end]}
            for i, (start, end, section) in enumerate(spans)]


def search(query, docs):
    # Longest alias first (安全超文本传输协议 before 超文本传输协议); keep the original
    # wording so notes that only use the Chinese term can still match.
    lowered = query
    for alias in sorted(ALIASES, key=len, reverse=True):
        if alias in lowered:
            query += " " + ALIASES[alias]
            lowered = lowered.replace(alias, "")
    terms = set(tokenize(query))
    anchors = set(re.findall(r"[a-z][a-z0-9]*|/\d{1,2}|\d{2,}", query.lower()))
    corpus = [chunk for doc in docs for chunk in chunks(doc)]
    if not corpus or not terms:
        return []
    counts = [Counter(tokenize(c["content"] + " " + c["section"])) for c in corpus]
    average = sum(sum(c.values()) for c in counts) / len(counts) or 1
    df = {term: sum(term in count for count in counts) for term in terms}
    ranked = []
    for chunk, count in zip(corpus, counts):
        title = set(tokenize(chunk["title"]))
        score = 0
        matched = 0
        for term in terms:
            freq = count[term]
            if not freq:
                continue
            matched += 1
            idf = math.log(1 + (len(corpus) - df[term] + .5) / (df[term] + .5))
            score += idf * (freq * 2.2 / (freq + 1.2 * (.25 + .75 * sum(count.values()) / average)))
            if term in title:
                score += 3
        # Require meaningful coverage, rather than always accepting the best weak match.
        coverage = matched / max(len(terms), 1)
        anchored = bool(anchors & set(count))
        if matched and (anchored or (coverage >= .24 and (matched >= 2 or len(terms) <= 2))):
            ranked.append((score, chunk))
    ranked.sort(key=lambda pair: -pair[0])
    threshold = ranked[0][0] * .35 if ranked else 0
    result, per_doc = [], Counter()
    for score, chunk in ranked:
        if score < threshold or per_doc[chunk["doc_id"]] >= 2:
            continue
        result.append(chunk)
        per_doc[chunk["doc_id"]] += 1
        if len(result) == 5:
            break
    return result
