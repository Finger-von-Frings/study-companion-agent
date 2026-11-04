'use strict';
/*
 * 学伴前端：原生 JavaScript，无构建步骤。
 * 依赖 static/vendor 下的 marked（Markdown）、DOMPurify（清洗）、highlight.js（代码高亮）。
 * 布局：左侧导航与历史 / 中间对话 / 右侧回答依据与资料原文。
 */

/* ========== 基础工具 ========== */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/** 创建元素：h('button', {class: 'btn', onclick: fn}, '文字', child) */
function h(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.flat().filter(child => child !== null && child !== undefined && child !== false));
  return node;
}

const ICONS = {
  plus: 'M12 5v14M5 12h14',
  chat: 'M4 5h16v11H9l-5 4z',
  book: 'M4 5.5A1.5 1.5 0 0 1 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5zM20 5.5A1.5 1.5 0 0 0 18.5 4H13v16h5.5a1.5 1.5 0 0 0 1.5-1.5z',
  review: 'M4 12a8 8 0 1 0 2.4-5.7M4 4v4.5h4.5',
  trash: 'M5 7h14M10 11v6M14 11v6M6.5 7l1 13h9l1-13M9 7V4h6v3',
  close: 'M6 6l12 12M18 6 6 18',
  menu: 'M4 7h16M4 12h16M4 17h16',
  send: 'M5 12h13M12 5l7 7-7 7',
  panel: 'M4 5h16v14H4zM14 5v14',
  back: 'M15 5l-7 7 7 7',
  doc: 'M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6',
  upload: 'M12 16V4M7 9l5-5 5 5M5 20h14',
  sun: 'M12 4V2M12 22v-2M4 12H2M22 12h-2M5.6 5.6 4.2 4.2M19.8 19.8l-1.4-1.4M5.6 18.4l-1.4 1.4M19.8 4.2l-1.4 1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z',
};

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

/** 浏览器存储只保存个人偏好；隐私模式下读写可能失败，失败时忽略。 */
const prefs = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* ignore */ } },
};

const letter = index => String.fromCharCode(65 + index);
const snippet = text => text.replace(/^#+\s.*$/gm, '').replace(/\s+/g, ' ').trim().slice(0, 80);

async function api(path, body) {
  const options = body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  };
  const response = await fetch(path, options);
  let data;
  try { data = await response.json(); } catch { throw new Error('服务返回了无法识别的内容'); }
  if (!response.ok) throw new Error(data.error || '请求失败');
  return data;
}

/* ========== 常量与状态 ========== */

const MODE_NAMES = { explain: '直接讲解', guide: '引导学习', test: '自我检测' };
const MODE_HELP = {
  explain: '直接讲解：根据资料解释知识点，给出例子和易错点。',
  guide: '引导学习：用提问和提示一步步带你想明白，不直接给整套答案。',
  test: '自我检测：输入一个知识点，直接出题，提交后再看解析。',
};
// 课程分组依次使用网线 T568B 线对的颜色：橙、绿、蓝；棕色用于其他资料。
const GROUP_KEYS = ['app', 'transport', 'network'];
const UPLOADS = '__uploads';
const VIEW_TITLES = { study: '学习工作台', library: '我的资料库', review: '错题与进度' };

const S = {
  status: null,          // /api/status 的返回
  currentId: null,       // 当前会话
  view: 'study',
  busy: false,
  course: prefs.get('study-course'),
  libraryFilter: '',
  reviewTab: 'due',
  mistakes: [],
  activeSources: [],     // 右侧面板当前展示的依据
  docCache: new Map(),
  pendingFile: null,
  docRequest: 0,
};

/* ========== 通用界面状态 ========== */

function notice(text, error = false) {
  const box = $('#notice');
  box.textContent = text;
  box.hidden = !text;
  box.classList.toggle('error', error);
}

function setBusy(value) {
  S.busy = value;
  document.body.classList.toggle('is-busy', value);
  $$('.lock').forEach(node => { node.disabled = value; });
  $('#send').disabled = value;
  $('#send-label').textContent = value ? '处理中' : '发送';
}

function showView(name) {
  S.view = name;
  document.body.dataset.view = name;
  $$('.view').forEach(view => { view.hidden = view.id !== name + '-view'; });
  $$('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.view === name));
  $('#page-title').textContent = VIEW_TITLES[name];
  closeDrawers();
}

function closeDrawers() {
  document.body.classList.remove('nav-open', 'panel-open');
}

function currentTheme() {
  return document.documentElement.dataset.theme
    || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}

/** persist=false 时只同步按钮图标，主题继续跟随系统设置。 */
function applyTheme(theme, persist = true) {
  if (persist) {
    document.documentElement.dataset.theme = theme;
    prefs.set('study-theme', theme);
  }
  const label = theme === 'dark' ? '切换到浅色模式' : '切换到深色模式';
  $('#theme-toggle').setAttribute('aria-label', label);
  $('#theme-toggle').title = label;
  $('#theme-icon').replaceChildren(icon(theme === 'dark' ? 'sun' : 'moon'));
}

function getMode() {
  return $('input[name=mode]:checked')?.value || 'explain';
}

function setMode(mode) {
  const radio = $(`input[name=mode][value="${mode}"]`) || $('input[name=mode][value=explain]');
  radio.checked = true;
  updateComposerNote();
}

function updateComposerNote() {
  $('#mode-help').textContent = MODE_HELP[getMode()];
  const demo = S.status?.mode === 'demo';
  $('#footnote').textContent = demo
    ? '当前是离线模式：只检索原文并使用内置题库，不调用大模型。'
    : 'Enter 发送，Shift + Enter 换行。';
}

function autosize() {
  const box = $('#question');
  box.style.height = 'auto';
  box.style.height = Math.min(box.scrollHeight, 200) + 'px';
}

function scrollChat({ soft = false } = {}) {
  const box = $('#chat-scroll');
  if (soft && box.scrollHeight - box.scrollTop - box.clientHeight > 160) return;
  box.scrollTop = box.scrollHeight;
}

/* ========== 课程与资料辅助 ========== */

const courseById = id => S.status?.courses.find(course => course.id === id);
const topicOf = id => S.status?.stats.topics.find(topic => topic.id === id);
const docById = id => S.status?.materials.find(doc => doc.id === id);

/** 资料属于哪门课程、哪个分组，决定颜色和标签。 */
function layerOf(id) {
  for (const course of S.status?.courses || []) {
    if (course.overview === id) return { key: 'overview', name: '总览', course };
    const index = course.groups.findIndex(group => group.ids.includes(id));
    if (index >= 0) return { key: GROUP_KEYS[index] || 'extra', name: course.groups[index].name, course };
  }
  const course = courseById(docById(id)?.course);
  return { key: 'extra', name: course ? '其他笔记' : '我的上传', course };
}

function layerLabel(id) {
  const layer = layerOf(id);
  return layer.course ? `${layer.course.name}，${layer.name}` : '我的上传';
}

function scopeName(id) {
  if (!id) return '全部资料';
  if (id.startsWith('course:')) return '整门课程：' + (courseById(id.slice(7))?.name || id.slice(7));
  return docById(id)?.title || '已删除的资料';
}

function meter(topic) {
  const wrap = h('span', { class: 'meter' });
  if (!topic) {
    wrap.append(h('small', { text: '还没练习' }));
    return wrap;
  }
  const fill = h('i');
  fill.style.width = Math.round(topic.correct / topic.total * 100) + '%';
  wrap.append(h('small', { text: `答对 ${topic.correct}/${topic.total} 题` }),
    h('span', { class: 'meter-bar', 'aria-hidden': 'true' }, fill));
  return wrap;
}

/** 选中一个知识点：切换范围并填好问题，由用户决定是否发送。 */
function pickTopic(doc) {
  if (S.busy) return;
  showView('study');
  $('#document-scope').value = doc.id;
  $('#question').value = `请讲解「${doc.title}」的核心知识点，并指出初学者的易错点。`;
  autosize();
  $('#question').focus();
}

/* ========== 右侧面板：回答依据 / 资料原文 ========== */

const isWide = () => matchMedia('(min-width: 1280px)').matches;

function revealPanel() {
  if (isWide() && S.view === 'study') document.body.classList.remove('panel-collapsed');
  else document.body.classList.add('panel-open');
}

function togglePanel() {
  if (isWide() && S.view === 'study') document.body.classList.toggle('panel-collapsed');
  else document.body.classList.toggle('panel-open');
}

function hidePanel() {
  if (isWide() && S.view === 'study') document.body.classList.add('panel-collapsed');
  document.body.classList.remove('panel-open');
}

function setPanelMode(mode) {
  $('#panel-sources').hidden = mode !== 'sources';
  $('#panel-doc').hidden = mode !== 'doc';
  $('#panel-title').textContent = mode === 'doc' ? '资料原文' : '回答依据';
  $('#panel-back').hidden = mode !== 'doc' || !S.activeSources.length;
}

function sourceCard(source, index) {
  const id = source.doc_id || source.id;
  const where = source.section && source.section !== source.title
    ? `${source.section}，片段 ${source.chunk_index || 1}` : `片段 ${source.chunk_index || 1}`;
  return h('button', { type: 'button', class: 'source-card layer-' + layerOf(id).key, onclick: () => showDoc(source) },
    h('span', { class: 'source-no', text: String(index + 1) }),
    h('span', { class: 'source-body' },
      h('strong', { text: source.title }),
      h('small', { text: `${layerLabel(id)} · ${where}` }),
      h('span', { class: 'source-snippet', text: snippet(source.content || '') + '…' })));
}

function renderSources(sources, { reveal = false } = {}) {
  ++S.docRequest;
  S.activeSources = sources || [];
  const box = $('#panel-sources');
  box.replaceChildren();
  if (!S.activeSources.length) {
    box.append(h('div', { class: 'panel-empty' },
      h('span', { class: 'panel-empty-icon' }, icon('doc')),
      h('p', { text: '回答所依据的资料片段会列在这里。' }),
      h('p', { class: 'muted', text: '点击回答里的编号引用或这里的片段，可以查看原文，并高亮命中的段落。' })));
  } else {
    box.append(h('p', { class: 'panel-hint', text: `本次回答检索到 ${S.activeSources.length} 个资料片段` }));
    S.activeSources.forEach((source, index) => box.append(sourceCard(source, index)));
  }
  setPanelMode('sources');
  if (reveal) revealPanel();
}

async function fullDoc(id) {
  if (!S.docCache.has(id)) S.docCache.set(id, await api('/api/document?id=' + encodeURIComponent(id)));
  return S.docCache.get(id);
}

async function showDoc(source) {
  const request = ++S.docRequest;
  const id = source.doc_id || source.id;
  let original;
  let missing = false;
  try {
    original = await fullDoc(id);
  } catch (error) {
    if (!source.content) { notice(error.message, true); return; }
    original = { title: source.title, file: '', content: source.content };
    missing = true;
  }
  if (request !== S.docRequest) return;
  const isChunk = Boolean(source.chunk_index);
  $('#doc-meta').textContent = layerLabel(id) + (isChunk ? `，片段 ${source.chunk_index}` : '');
  $('#doc-title').textContent = original.title;
  $('#doc-hint').textContent = missing ? '原资料已删除，这里只显示当时引用的片段。'
    : isChunk ? '高亮部分是本次检索命中的段落。' : original.file;
  const body = $('#doc-content');
  body.replaceChildren();
  const hasRange = Number.isInteger(source.start) && original.content.slice(source.start, source.end) === source.content;
  if (hasRange) {
    body.append(original.content.slice(0, source.start), h('mark', { text: source.content }), original.content.slice(source.end));
  } else {
    body.textContent = original.content;
  }
  setPanelMode('doc');
  revealPanel();
  const mark = $('mark', body);
  requestAnimationFrame(() => { if (mark) mark.scrollIntoView({ block: 'center' }); else $('#panel-scroll').scrollTop = 0; });
}

/* ========== Markdown 渲染 ========== */

function renderMarkdown(target, text, sources = []) {
  // 模型输出不可信：只允许排版标签，不允许图片、表单或嵌入内容。
  target.innerHTML = DOMPurify.sanitize(marked.parse(text, { breaks: true }), {
    ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'del', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li',
      'blockquote', 'pre', 'code', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a'],
    ALLOWED_ATTR: ['href', 'title', 'class'], ALLOW_DATA_ATTR: false,
  });
  $$('a', target).forEach(link => {
    if (!/^https?:\/\//i.test(link.getAttribute('href') || '')) link.removeAttribute('href');
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
  });
  $$('pre code', target).forEach(code => { try { hljs.highlightElement(code); } catch { /* ignore */ } });

  // 把 [来源:id] 换成编号引用，编号与右侧依据卡片一致。
  const byId = new Map(sources.map((source, index) => [source.id, { source, index }]));
  const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    if (node.parentElement.closest('pre, code, a')) continue;
    const pattern = /\[来源:([^\]]+)\]/g;
    const value = node.textContent;
    let match;
    let last = 0;
    let changed = false;
    const fragment = document.createDocumentFragment();
    while ((match = pattern.exec(value))) {
      fragment.append(value.slice(last, match.index));
      const hit = byId.get(match[1]);
      if (hit) {
        fragment.append(h('button', {
          type: 'button', class: 'cite', title: hit.source.title, 'aria-label': `查看引用 ${hit.index + 1}：${hit.source.title}`,
          onclick: () => { renderSources(sources); showDoc(hit.source); },
        }, String(hit.index + 1)));
      } else {
        fragment.append(h('span', { class: 'cite-missing', text: '未核实的引用' }));
      }
      last = pattern.lastIndex;
      changed = true;
    }
    if (changed) {
      fragment.append(value.slice(last));
      node.replaceWith(fragment);
    }
  }
}

/* ========== 对话 ========== */

function userMessage(text) {
  const node = h('article', { class: 'msg msg-user' }, h('div', { class: 'bubble', text }));
  $('#chat').append(node);
  return node;
}

function assistantMessage() {
  const node = h('article', { class: 'msg msg-assistant' },
    h('div', { class: 'avatar', 'aria-hidden': 'true', text: '学' }),
    h('div', { class: 'msg-body' }));
  $('#chat').append(node);
  return node;
}

function renderReply(wrap, data, question = '') {
  const body = $('.msg-body', wrap);
  body.replaceChildren();
  const content = h('div', { class: 'markdown' });
  renderMarkdown(content, data.answer, data.sources);
  body.append(content);

  const meta = h('div', { class: 'reply-meta' });
  if (data.settings) {
    meta.append(h('span', { class: 'tag', text: MODE_NAMES[data.settings.mode] || '直接讲解' }),
      h('span', { class: 'tag', text: scopeName(data.settings.document_id) }));
  }
  if (data.sources.length) {
    meta.append(h('button', { type: 'button', class: 'tag tag-action', onclick: () => renderSources(data.sources, { reveal: true }) },
      icon('doc'), `${data.sources.length} 个依据`));
  }
  body.append(meta);

  if (data.trace.length) {
    body.append(h('details', { class: 'trace' },
      h('summary', { text: `查看 ${data.trace.length} 次工具调用` }),
      data.trace.map(step => h('p', {}, h('code', { text: step.tool }), ` ${step.detail}：${step.result}`))));
  }
  data.quizzes.forEach(quiz => body.append(quizCard(quiz)));

  const followups = [['举例说明', '请围绕刚才的知识点举一个通俗例子。'],
    ['再简单一点', '请把刚才的知识点解释得更简单一点。'],
    ['出题考我', '围绕刚才的知识点出 3 道选择题。']];
  body.append(h('div', { class: 'followups' }, followups.map(([label, prompt]) =>
    h('button', { type: 'button', class: 'chip lock', disabled: S.busy, onclick: () => { if (S.busy) return; setMode(data.settings?.mode || 'explain'); $('#document-scope').value = data.settings?.document_id || ''; send(question ? '针对这个问题：'+question+'\n'+prompt : prompt); } }, label))));
}

async function readStream(body, onEvent) {
  const response = await fetch('/api/chat/stream', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error((await response.json()).error || '请求失败');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let completed = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let index;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (!block.startsWith('data: ')) continue;
        const event = JSON.parse(block.slice(6));
        if (event.type === 'error') throw new Error(event.error);
        if (event.type === 'done') completed = true;
        onEvent(event);
      }
      if (done) break;
    }
    if (!completed) throw new Error('连接中断，回答尚未完成');
  } finally {
    await reader.cancel().catch(() => {});
  }
}

async function send(rawText) {
  const text = rawText.trim();
  if (S.busy || !text) return;
  if (text.length > 2000) { notice('问题请控制在 2000 字以内', true); return; }
  notice('');
  setBusy(true);
  showView('study');
  $('#welcome').hidden = true;
  userMessage(text);
  $('#question').value = '';
  autosize();

  const reply = assistantMessage();
  const body = $('.msg-body', reply);
  const phase = h('span', { text: '正在连接学伴…' });
  const progress = h('div', { class: 'progress' }, h('span', { class: 'pulse', 'aria-hidden': 'true' }), phase);
  const live = h('div', { class: 'streaming' });
  body.append(progress, live);
  scrollChat();

  let streamed = '';
  let completed = false;
  const settings = { mode: getMode(), document_id: $('#document-scope').value || null };
  try {
    await readStream({ message: text, conversation_id: S.currentId, settings }, event => {
      if (event.type === 'phase') phase.textContent = event.text;
      if (event.type === 'reset_text') { streamed = ''; live.textContent = ''; }
      if (event.type === 'delta') { streamed += event.text; live.textContent = streamed; scrollChat({ soft: true }); }
      if (event.type === 'tool') phase.textContent = `${event.result}：${event.detail}`;
      if (event.type === 'done') {
        S.currentId = event.conversation_id;
        renderReply(reply, event, text);
        renderSources(event.sources);
        completed = true;
      }
    });
    await refreshState();
  } catch (error) {
    if (completed) {
      notice('回答已保存，但列表刷新失败，请刷新页面。', true);
    } else {
      progress.classList.add('error');
      phase.textContent = error.message + '。本次没有完成，可以重试。';
      body.append(h('button', {
        type: 'button', class: 'btn btn-ghost btn-sm lock',
        onclick: () => { if (S.busy) return; setMode(settings.mode); $('#document-scope').value = settings.document_id || ''; reply.previousElementSibling?.remove(); reply.remove(); send(text); },
      }, '重新发送'));
      $('#question').value = text;
      autosize();
    }
  } finally {
    setBusy(false);
    $('#question').focus();
  }
}

async function loadConversation(cid) {
  const data = await api('/api/select', { conversation_id: cid });
  setMode(data.settings?.mode || 'explain');
  $('#document-scope').value = data.settings?.document_id || '';
  S.currentId = cid;
  showView('study');
  $('#chat').replaceChildren();
  $('#welcome').hidden = data.turns.length > 0;
  data.turns.forEach(turn => {
    userMessage(turn.question);
    renderReply(assistantMessage(), turn.response, turn.question);
  });
  renderSources(data.turns.at(-1)?.response.sources || []);
  renderHistory();
  $('#question').value = '';
  autosize();
  requestAnimationFrame(() => {
    if (data.turns.length) scrollChat(); else $('#chat-scroll').scrollTop = 0;
  });
}

async function openConversation(cid) {
  if (S.busy) return;
  setBusy(true);
  try { await loadConversation(cid); } catch (error) { notice(error.message, true); } finally { setBusy(false); }
}

async function newConversation() {
  if (S.busy) return;
  setBusy(true);
  notice('');
  try {
    const data = await api('/api/reset', {});
    S.currentId = data.conversation_id;
    await refreshState();
    await loadConversation(S.currentId);
  } catch (error) { notice(error.message, true); } finally { setBusy(false); }
}

async function deleteConversation(conversation) {
  if (S.busy || !confirm(`删除学习记录「${conversation.title}」？练习成绩和错题本会保留。`)) return;
  setBusy(true);
  notice('');
  try {
    const data = await api('/api/delete_conversation', { conversation_id: conversation.id });
    const wasCurrent = conversation.id === S.currentId;
    if (wasCurrent) S.currentId = data.conversation_id;
    await refreshState();
    if (wasCurrent) await loadConversation(S.currentId);
  } catch (error) { notice(error.message, true); } finally { setBusy(false); }
}

/* ========== 练习 ========== */

function quizCard(quiz) {
  const total = quiz.questions.length;
  const count = h('span', { class: 'quiz-count', text: `已作答 0 / ${total}` });
  const form = h('form', { class: 'quiz' },
    h('header', { class: 'quiz-head' },
      h('div', {}, h('h3', { text: `随堂练习 · ${total} 题` }),
        h('p', { class: 'muted', text: '提交后显示答案与解析，答错的题自动收录到错题本。' })),
      count));
  quiz.questions.forEach((question, i) => {
    const field = h('fieldset', { class: 'question' },
      h('legend', {}, h('span', { class: 'q-no', text: String(i + 1) }), question.question));
    question.options.forEach((option, j) => field.append(
      h('label', { class: 'option' },
        h('input', { type: 'radio', name: 'q' + i, value: String(j), required: true }),
        h('span', { class: 'option-letter', text: letter(j) }),
        h('span', { class: 'option-text', text: option }))));
    form.append(field);
  });
  const status = h('p', { class: 'quiz-status', role: 'alert' });
  const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, '提交并查看解析');
  form.append(h('div', { class: 'quiz-actions' }, submit, status));

  form.addEventListener('change', () => {
    const answered = new Set($$('input:checked', form).map(input => input.name)).size;
    count.textContent = `已作答 ${answered} / ${total}`;
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (submit.disabled || !form.reportValidity()) return;
    submit.disabled = true;
    status.textContent = '';
    try {
      const data = new FormData(form);
      const answers = quiz.questions.map((_, i) => Number(data.get('q' + i)));
      renderGrade(form, await api('/api/grade', { quiz_id: quiz.id, answers }));
      await refreshState();
    } catch (error) {
      status.textContent = error.message;
      if (!form.classList.contains('graded')) submit.disabled = false;
    }
  });
  if (quiz.grade) renderGrade(form, quiz.grade);
  return form;
}

function renderGrade(form, grade) {
  form.classList.add('graded');
  $$('fieldset', form).forEach((field, i) => {
    const result = grade.results[i];
    $$('input', field).forEach((input, j) => {
      input.checked = j === result.selected;
      input.disabled = true;
      const option = input.closest('.option');
      option.classList.toggle('is-correct', j === result.answer);
      option.classList.toggle('is-wrong', j === result.selected && !result.correct);
    });
    $$('.explain', field).forEach(node => node.remove());
    field.append(h('div', { class: 'explain ' + (result.correct ? 'ok' : 'bad') },
      h('strong', { text: result.correct ? '回答正确' : '已收录到错题本' }),
      h('span', { text: `正确答案 ${letter(result.answer)}。${result.explanation}` })));
  });
  $('.quiz-count', form).textContent = `得分 ${grade.score} / ${grade.total}`;
  const submit = $('button[type=submit]', form);
  submit.disabled = true;
  submit.textContent = '已完成，结果已保存';
}

/* ========== 侧栏历史 ========== */

function dayLabel(timestamp) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000;
  if (timestamp >= today) return '今天';
  if (timestamp >= today - 86400) return '昨天';
  if (timestamp >= today - 6 * 86400) return '近 7 天';
  return '更早';
}

function renderHistory() {
  const box = $('#history');
  box.replaceChildren();
  const list = S.status.conversations;
  if (!list.length) { box.append(h('p', { class: 'side-empty', text: '还没有学习记录' })); return; }
  let lastLabel = null;
  list.forEach(conversation => {
    const label = dayLabel(conversation.updated);
    if (label !== lastLabel) { box.append(h('p', { class: 'side-label', text: label })); lastLabel = label; }
    box.append(h('div', { class: 'history-row' + (conversation.id === S.currentId ? ' selected' : '') },
      h('button', {
        type: 'button', class: 'history-item lock', title: conversation.title, disabled: S.busy,
        'aria-current': conversation.id === S.currentId ? 'true' : null,
        onclick: () => openConversation(conversation.id),
      }, h('span', { text: conversation.title })),
      h('button', {
        type: 'button', class: 'history-delete lock', title: '删除这条学习记录', disabled: S.busy,
        'aria-label': '删除学习记录：' + conversation.title, onclick: () => deleteConversation(conversation),
      }, icon('trash'))));
  });
}

/* ========== 首页 ========== */

function greeting() {
  const hour = new Date().getHours();
  if (hour < 6) return '夜深了，注意休息';
  if (hour < 11) return '早上好';
  if (hour < 14) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
}

function statItems(target, items) {
  target.replaceChildren(...items.map(([value, label]) =>
    h('div', { class: 'stat' }, h('dd', { text: String(value) }), h('dt', { text: label }))));
}

function renderReviewCard() {
  const card = $('#review-card');
  const stats = S.status.stats;
  card.replaceChildren();
  card.classList.toggle('due', stats.pending > 0);
  if (stats.pending > 0) {
    card.append(h('strong', { text: `${stats.pending} 道错题到期` }),
      h('p', { text: '趁记忆还没完全淡掉，花几分钟把它们重做一遍。' }),
      h('button', { type: 'button', class: 'btn btn-warn btn-sm', onclick: () => goReview() }, '开始复习'));
  } else if (!stats.attempts) {
    card.append(h('strong', { text: '还没有练习记录' }),
      h('p', { text: '完成一组练习后，答错的题会按 1、3、7 天的间隔安排复习。' }));
  } else {
    card.append(h('strong', { text: '今天没有到期的错题' }),
      h('p', { text: `已完成 ${stats.attempts} 次练习，累计正确率 ${stats.accuracy}%。可以挑一个还没练过的知识点继续。` }));
  }
}

function topicChip(doc) {
  return h('button', {
    type: 'button', class: 'topic lock', disabled: S.busy, 'aria-label': '学习' + doc.title, onclick: () => pickTopic(doc),
  }, h('strong', { text: doc.title }), meter(topicOf(doc.id)));
}

function courseTabs() {
  const tabs = S.status.courses.map(course => ({
    id: course.id, name: course.name, count: S.status.materials.filter(doc => doc.course === course.id).length,
  }));
  const uploads = S.status.materials.filter(doc => doc.uploaded).length;
  if (uploads) tabs.push({ id: UPLOADS, name: '我的上传', count: uploads });
  return tabs;
}

function selectCourse(id) {
  if (S.busy) return;
  $('#document-scope').value = id === UPLOADS ? '' : 'course:' + id;
  S.course = id;
  prefs.set('study-course', id);
  renderCourseMap();
  renderSuggestions();
}

function renderCourseMap() {
  const tabs = courseTabs();
  if (!tabs.some(tab => tab.id === S.course)) S.course = tabs[0]?.id;
  $('#course-tabs').replaceChildren(...tabs.map(tab => h('button', {
    type: 'button', disabled: S.busy, class: 'course-tab lock' + (tab.id === S.course ? ' selected' : ''),
    'aria-pressed': String(tab.id === S.course), onclick: () => selectCourse(tab.id),
  }, h('span', { text: tab.name }), h('small', { text: `${tab.count} 篇` }))));

  const map = $('#course-map');
  const course = courseById(S.course);
  const byId = new Map(S.status.materials.map(doc => [doc.id, doc]));
  const head = h('div', { class: 'map-head' });
  const intro = h('div', { class: 'map-intro' });
  head.append(intro);
  let rows;
  if (course) {
    intro.append(h('p', { text: course.description }),
      h('button', {
        type: 'button', class: 'link-btn lock', disabled: S.busy,
        onclick: () => { if (S.busy) return; $('#document-scope').value = 'course:' + course.id; $('#question').focus(); },
      }, `只在「${course.name}」里提问`));
    if (byId.has(course.overview)) {
      const overview = topicChip(byId.get(course.overview));
      overview.classList.add('topic-overview');
      overview.prepend(h('small', { class: 'overview-label', text: '先看总览' }));
      head.append(overview);
    }
    const placed = new Set([course.overview]);
    rows = course.groups.map((group, index) => {
      group.ids.forEach(id => placed.add(id));
      return { key: GROUP_KEYS[index] || 'extra', name: group.name, hint: group.hint,
        docs: group.ids.filter(id => byId.has(id)).map(id => byId.get(id)) };
    });
    const extra = S.status.materials.filter(doc => doc.course === course.id && !placed.has(doc.id));
    if (extra.length) rows.push({ key: 'extra', name: '其他笔记', hint: '还没归入分组', docs: extra });
  } else {
    intro.append(h('p', { text: '你上传的课堂笔记，提问时会和课程资料一起检索。' }));
    rows = [{ key: 'extra', name: '我的上传', hint: '自己的课堂笔记', docs: S.status.materials.filter(doc => doc.uploaded) }];
  }
  map.replaceChildren(head, ...rows.filter(row => row.docs.length).map(row =>
    h('div', { class: 'layer layer-' + row.key },
      h('div', { class: 'layer-name' }, h('strong', { text: row.name }), h('small', { text: row.hint })),
      h('div', { class: 'layer-topics' }, row.docs.map(topicChip)))));
}

function renderSuggestions() {
  const course = courseById(S.course);
  // 「我的上传」标签下，从每门课各取一个入门问题。
  const items = course ? course.suggestions
    : S.status.courses.map(c => c.suggestions[0] && { ...c.suggestions[0], tag: c.name }).filter(Boolean);
  $('#suggestions').replaceChildren(...items.slice(0, 3).map(item => h('button', {
    type: 'button', class: 'suggestion lock', disabled: S.busy, onclick: () => { if (S.busy) return; $('#document-scope').value = course ? 'course:' + course.id : ''; send(item.prompt); },
  }, h('span', { class: 'suggestion-tag', text: item.tag }), h('strong', { text: item.title }), h('small', { text: item.hint }))));
}

function renderWelcome() {
  const stats = S.status.stats;
  $('#greeting').textContent = greeting();
  statItems($('#welcome-stats'), [
    [S.status.materials.length, '份学习资料'],
    [stats.attempts, '次完成练习'],
    [stats.accuracy === null ? '—' : stats.accuracy + '%', '累计答题正确率'],
    [stats.topics.length, '个知识点做过练习'],
  ]);
  renderReviewCard();
  renderCourseMap();
  renderSuggestions();
}

function renderScopeOptions() {
  const scope = $('#document-scope');
  const selected = scope.value;
  scope.replaceChildren(new Option('全部资料', ''));
  const group = (label, options) => scope.append(h('optgroup', { label }, options));
  S.status.courses.forEach(course => group(course.name, [
    new Option('整门课程：' + course.name, 'course:' + course.id),
    ...S.status.materials.filter(doc => doc.course === course.id).map(doc => new Option(doc.title, doc.id)),
  ]));
  const others = S.status.materials.filter(doc => !courseById(doc.course));
  if (others.length) group('我的上传', others.map(doc => new Option(doc.title, doc.id)));
  scope.value = [...scope.options].some(o => o.value === selected) ? selected : '';
}

/* ========== 资料库 ========== */

function renderLibrary() {
  const filters = [['', '全部'], ...S.status.courses.map(course => [course.id, course.name])];
  if (S.status.materials.some(doc => doc.uploaded)) filters.push([UPLOADS, '我的上传']);
  if (!filters.some(([id]) => id === S.libraryFilter)) S.libraryFilter = '';
  $('#library-filters').replaceChildren(...filters.map(([id, name]) => h('button', {
    type: 'button', class: 'chip' + (id === S.libraryFilter ? ' selected' : ''), 'aria-pressed': String(id === S.libraryFilter),
    onclick: () => { S.libraryFilter = id; renderLibrary(); },
  }, name)));

  const query = $('#library-search').value.trim().toLowerCase();
  const inFilter = doc => !S.libraryFilter || (S.libraryFilter === UPLOADS ? doc.uploaded : doc.course === S.libraryFilter);
  const docs = S.status.materials.filter(doc => inFilter(doc) && (doc.title + ' ' + doc.file).toLowerCase().includes(query));
  const grid = $('#library-grid');
  grid.replaceChildren(...docs.map(doc => h('article', { class: 'doc-card layer-' + layerOf(doc.id).key },
    h('p', { class: 'doc-kind', text: layerLabel(doc.id) }),
    h('h3', { text: doc.title }),
    h('p', { class: 'doc-preview', text: doc.preview + '…' }),
    meter(topicOf(doc.id)),
    h('footer', { class: 'doc-foot' },
      h('small', { text: `${doc.length} 字 · ${doc.file.split('.').pop().toUpperCase()}` }),
      h('div', { class: 'doc-actions' },
        h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => showDoc(doc) }, '原文'),
        h('button', { type: 'button', class: 'btn btn-soft btn-sm lock', disabled: S.busy, onclick: () => pickTopic(doc) }, '提问'),
        doc.uploaded ? h('button', {
          type: 'button', class: 'icon-btn danger lock', disabled: S.busy, title: '删除这份资料',
          'aria-label': '删除资料：' + doc.title, onclick: () => deleteDocument(doc),
        }, icon('trash')) : null)))));
  if (!docs.length) grid.append(h('p', { class: 'empty', text: '没有匹配的资料。换个关键词，或者切换课程筛选。' }));
}

async function deleteDocument(doc) {
  if (S.busy || !confirm(`删除资料「${doc.title}」？之后提问不再检索它，历史回答中的引用片段仍可查看。`)) return;
  setBusy(true);
  notice('');
  try {
    await api('/api/delete_document', { id: doc.id });
    S.docCache.delete(doc.id);
    await refreshState();
    notice(`已删除资料「${doc.title}」。`);
  } catch (error) { notice(error.message, true); } finally { setBusy(false); }
}

function chooseFile(file) {
  S.pendingFile = file || null;
  $('#file-name').textContent = S.pendingFile ? S.pendingFile.name : '未选择文件';
  $('#dropzone').classList.toggle('has-file', Boolean(S.pendingFile));
}

async function uploadFile(event) {
  event.preventDefault();
  const file = S.pendingFile;
  const status = $('#upload-status');
  const button = $('#upload-button');
  status.textContent = '';
  status.classList.remove('error');
  if (!file) { status.textContent = '请先选择资料文件。'; return; }
  if (file.size > 200000 || !/\.(md|txt)$/i.test(file.name)) {
    status.textContent = '请选择 200 KB 以内的 Markdown / TXT 文件。';
    status.classList.add('error');
    return;
  }
  button.disabled = true;
  try {
    let content;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()); }
    catch { throw new Error('无法读取文件，请确认使用 UTF-8 编码。'); }
    await api('/api/upload', { filename: file.name, content });
    status.textContent = `已上传「${file.name}」，提问时就能检索到它。`;
    $('#upload-file').value = '';
    chooseFile(null);
    await refreshState();
  } catch (error) {
    status.textContent = error.message;
    status.classList.add('error');
  } finally {
    button.disabled = false;
  }
}

/* ========== 错题与进度 ========== */

async function goReview() {
  if (S.busy) return;
  notice('');
  showView('review');
  try { await loadReview(); } catch (error) { notice(error.message, true); }
}

async function loadReview() {
  const data = await api('/api/mistakes');
  S.mistakes = data.mistakes;
  const later = S.mistakes.filter(m => !m.is_due).length;
  statItems($('#review-stats'), [
    [data.stats.attempts, '次完成练习'],
    [data.stats.accuracy === null ? '—' : data.stats.accuracy + '%', '累计答题正确率'],
    [data.stats.pending, '道今日待复习'],
    [later, '道待巩固'],
  ]);
  const topics = $('#topic-list');
  topics.replaceChildren(...data.stats.topics.map(topic => h('div', { class: 'topic-row layer-' + layerOf(topic.id).key },
    h('strong', { text: docById(topic.id)?.title || topic.id }), meter(topic))));
  if (!data.stats.topics.length) topics.append(h('p', { class: 'muted', text: '完成练习后，这里会显示各知识点的答题情况。' }));
  renderMistakes();
}

function renderMistakes() {
  const due = S.mistakes.filter(m => m.is_due);
  const later = S.mistakes.filter(m => !m.is_due);
  $('#tab-due').textContent = `今日待复习 ${due.length}`;
  $('#tab-later').textContent = `待巩固 ${later.length}`;
  $('#tab-due').classList.toggle('selected', S.reviewTab === 'due');
  $('#tab-later').classList.toggle('selected', S.reviewTab === 'later');
  $('#retry-all').disabled = !due.length;

  const list = $('#mistake-list');
  const shown = S.reviewTab === 'due' ? due : later;
  list.replaceChildren(...shown.map(mistakeCard));
  if (!shown.length) {
    list.append(h('p', { class: 'empty', text: S.reviewTab === 'due'
      ? '今天没有需要复习的错题。完成一组练习，检验一下掌握情况吧。'
      : '暂时没有待巩固的题。重练答对的题会出现在这里，到期后再复习。' }));
  }
}

function mistakeCard(mistake) {
  const question = mistake.question;
  const docId = question.source_id.split('::')[0];
  const when = mistake.is_due ? '已到复习时间'
    : '下次复习 ' + new Date(mistake.due * 1000).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return h('article', { class: 'mistake layer-' + layerOf(docId).key },
    h('header', { class: 'mistake-head' },
      h('span', { class: 'doc-kind', text: docById(docId)?.title || docId }),
      h('span', { class: 'due-tag' + (mistake.is_due ? ' is-due' : ''), text: when })),
    h('h3', { text: question.question }),
    h('ol', { class: 'mistake-options' }, question.options.map((option, i) =>
      h('li', { class: i === mistake.selected ? 'picked' : '' },
        h('span', { class: 'option-letter', text: letter(i) }), h('span', { text: option }),
        i === mistake.selected ? h('small', { text: '上次选了这个' }) : null))),
    h('details', { class: 'mistake-answer' },
      h('summary', { text: '查看答案与解析' }),
      h('p', { text: `正确答案 ${letter(question.answer)}。${question.explanation}` })),
    h('footer', { class: 'mistake-foot' },
      h('small', { text: `累计答错 ${mistake.wrong_count} 次` }),
      h('button', { type: 'button', class: 'btn btn-soft btn-sm lock', disabled: S.busy, onclick: () => retryMistakes([mistake.id]) },
        mistake.is_due ? '复习这一题' : '提前巩固')));
}

async function retryMistakes(ids) {
  if (S.busy || !ids.length) return;
  setBusy(true);
  try {
    const data = await api('/api/retry', { ids });
    await refreshState();
    await loadConversation(data.conversation_id);
  } catch (error) { notice(error.message, true); } finally { setBusy(false); }
}

/* ========== 全局状态刷新 ========== */

async function refreshState() {
  S.status = await api('/api/status');
  if (!Array.isArray(S.status.courses)) {
    throw new Error('后端服务还是旧版本，请停止后重新运行 python3 app.py');
  }
  if (!S.currentId) S.currentId = S.status.conversation_id;
  const online = S.status.mode === 'online';
  $('#mode-dot').classList.toggle('online', online);
  $('#mode-status').textContent = online ? 'DeepSeek 在线' : '离线模式';
  $('#mode-detail').textContent = online ? S.status.model : '未配置 API 密钥';
  $('#nav-docs').textContent = S.status.materials.length;
  $('#nav-due').textContent = S.status.stats.pending || '';
  renderScopeOptions();
  updateComposerNote();
  renderHistory();
  renderWelcome();
  renderLibrary();
}

/* ========== 事件绑定与启动 ========== */

function bindEvents() {
  $$('.nav-item').forEach(item => item.addEventListener('click', () => {
    if (S.busy) return;
    if (item.dataset.view === 'review') { goReview(); return; }
    notice('');
    showView(item.dataset.view);
  }));
  $('#new-chat').addEventListener('click', newConversation);
  $('#menu-toggle').addEventListener('click', () => document.body.classList.toggle('nav-open'));
  $('#backdrop').addEventListener('click', closeDrawers);
  $('#panel-toggle').addEventListener('click', togglePanel);
  $('#panel-close').addEventListener('click', hidePanel);
  $('#panel-back').addEventListener('click', () => setPanelMode('sources'));
  $('#theme-toggle').addEventListener('click', () => applyTheme(currentTheme() === 'dark' ? 'light' : 'dark'));
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeDrawers(); });

  $('#composer').addEventListener('submit', event => { event.preventDefault(); send($('#question').value); });
  $('#question').addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); send($('#question').value); }
  });
  $('#question').addEventListener('input', autosize);
  $$('input[name=mode]').forEach(radio => radio.addEventListener('change', updateComposerNote));

  $('#library-search').addEventListener('input', renderLibrary);
  $('#upload-file').addEventListener('change', () => chooseFile($('#upload-file').files[0]));
  $('#upload-form').addEventListener('submit', uploadFile);
  const zone = $('#dropzone');
  ['dragenter', 'dragover'].forEach(type => zone.addEventListener(type, event => { event.preventDefault(); zone.classList.add('dragging'); }));
  ['dragleave', 'drop'].forEach(type => zone.addEventListener(type, () => zone.classList.remove('dragging')));
  zone.addEventListener('drop', event => { event.preventDefault(); chooseFile(event.dataTransfer.files[0]); });

  $('#tab-due').addEventListener('click', () => { S.reviewTab = 'due'; renderMistakes(); });
  $('#tab-later').addEventListener('click', () => { S.reviewTab = 'later'; renderMistakes(); });
  $('#retry-all').addEventListener('click', () => retryMistakes(S.mistakes.filter(m => m.is_due).slice(0, 5).map(m => m.id)));
}

async function start() {
  $$('[data-icon]').forEach(node => node.replaceChildren(icon(node.dataset.icon)));
  applyTheme(currentTheme(), false);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(currentTheme(), false));
  bindEvents();
  renderSources([]);
  setBusy(true);
  try {
    await refreshState();
    await loadConversation(S.currentId);
  } catch (error) {
    notice('连接失败：' + error.message + '。请刷新页面重试。', true);
  } finally {
    setBusy(false);
  }
}

start();
