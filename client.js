/**
 * Client half of the DSH learning plugin.
 *
 * Two levels inside one full main panel (the seat the Plugins page uses), with
 * an icon in the left sidebar's global panel list:
 *
 *   projects  — 项目管理页
 *   project   — 项目详情页：概览 / 章节 / 练习 / 资料 / 复习 / 任务
 *
 * All data comes from the Host half's HTTP API; nothing is kept in component
 * state beyond the last read. This file is plain JavaScript served straight from
 * disk, so edits reload in the page without reinstalling anything.
 */
window.__ModuleLoader__.load({
  id: '@local/dashin-learning',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    const API = '/dashin/api'
    const PANEL_ID = 'dashin-learning'

    /** The client directory picker, captured in apply(). Optional. */
    let uiWorkspace = null

    const TYPE_LABEL = { memory: '记忆', concept: '概念', procedure: '程序', design: '设计' }
    const TYPE_TONE = { memory: 'neutral', concept: 'brand', procedure: 'success', design: 'warn' }
    const STAGE_LABEL = {
      diagnostic: '诊断',
      explain: '讲解',
      feynman_check: '复述检验',
      practice: '练习',
      error_diagnosis: '错因诊断',
      review: '复习',
      completed: '完成',
    }
    const STAGES = Object.keys(STAGE_LABEL)
    const ERROR_LABEL = {
      structural: '知识结构性',
      deviation: '理解偏差',
      application: '应用错误',
      metacognitive: '元认知',
    }
    const ERROR_STATUS_LABEL = { active: '待解决', retrying: '重试中', review: '待复习', graduated: '已毕业' }
    const GRADE_LABEL = { again: '忘记', hard: '勉强', good: '记得', easy: '太简单' }
    const SOURCE_LABEL = {
      config: '插件配置指定',
      'workspace(session)': '当前会话工作区',
      workspace: '工作区',
      env: 'DSH_WORKSPACE',
      cwd: '进程目录',
    }
    const TABS = [
      ['overview', '概览'],
      ['chapters', '章节'],
      ['practice', '练习'],
      ['materials', '资料'],
      ['reviews', '复习'],
      ['tasks', '任务'],
    ]

    const message = (cause) => (cause && cause.message ? cause.message : String(cause))
    const when = (iso) => (iso ? String(iso).slice(0, 16).replace('T', ' ') : '—')
    const pct = (value) => `${Math.round((Number(value) || 0) * 100)}%`
    const askForQuiz = (name) => `给「${name}」出一道题，用 learning 的 quiz 动作`

    /* ------------------------------------------------------------ data */

    async function postAction(payload) {
      const response = await fetch(`${API}/action`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await response.json()
      if (!data.ok) throw new Error(data.error || '操作失败')
      return data.result
    }

    async function getJson(url) {
      const response = await fetch(url)
      const data = await response.json()
      if (!data.ok) throw new Error(data.error || '请求失败')
      return data
    }

    const fetchProjects = async () => (await getJson(`${API}/projects`)).state
    const fetchProject = async (id) => (await getJson(`${API}/project?id=${encodeURIComponent(id)}`)).state

    /* -------------------------------------------------- markdown (mini) */

    const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g

    function inline(text, keyPrefix) {
      const nodes = []
      let last = 0
      let index = 0
      let match
      INLINE.lastIndex = 0
      while ((match = INLINE.exec(text)) !== null) {
        if (match.index > last) nodes.push(text.slice(last, match.index))
        const token = match[0]
        if (token.startsWith('**')) nodes.push(h('strong', { key: `${keyPrefix}s${index++}` }, token.slice(2, -2)))
        else if (token.startsWith('`'))
          nodes.push(h('code', { key: `${keyPrefix}c${index++}`, className: 'dsl-inline-code' }, token.slice(1, -1)))
        else if (token.startsWith('*')) nodes.push(h('em', { key: `${keyPrefix}e${index++}` }, token.slice(1, -1)))
        else {
          const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
          if (link) nodes.push(h('a', { key: `${keyPrefix}a${index++}`, href: link[2], target: '_blank', rel: 'noreferrer' }, link[1]))
          else nodes.push(token)
        }
        last = match.index + token.length
      }
      if (last < text.length) nodes.push(text.slice(last))
      return nodes
    }

    function markdown(text) {
      const lines = String(text ?? '').split('\n')
      const blocks = []
      let cursor = 0
      let key = 0

      while (cursor < lines.length) {
        const line = lines[cursor]

        if (/^```/.test(line)) {
          const language = line.slice(3).trim()
          const buffer = []
          cursor += 1
          while (cursor < lines.length && !/^```/.test(lines[cursor])) {
            buffer.push(lines[cursor])
            cursor += 1
          }
          cursor += 1
          blocks.push(
            h('pre', { key: `b${key++}`, className: 'dsl-pre' }, h('code', { className: language ? `language-${language}` : undefined }, buffer.join('\n'))),
          )
          continue
        }

        const heading = /^(#{1,6})\s+(.*)$/.exec(line)
        if (heading) {
          const level = heading[1].length
          blocks.push(h(`h${level}`, { key: `b${key++}`, className: `dsl-md-h dsl-md-h${level}` }, inline(heading[2], `b${key}`)))
          cursor += 1
          continue
        }

        if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
          blocks.push(h('hr', { key: `b${key++}`, className: 'dsl-hr' }))
          cursor += 1
          continue
        }

        if (/^>\s?/.test(line)) {
          const buffer = []
          while (cursor < lines.length && /^>\s?/.test(lines[cursor])) {
            buffer.push(lines[cursor].replace(/^>\s?/, ''))
            cursor += 1
          }
          blocks.push(h('blockquote', { key: `b${key++}`, className: 'dsl-quote' }, markdown(buffer.join('\n'))))
          continue
        }

        if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
          const ordered = /^\s*\d+\.\s+/.test(line)
          const items = []
          while (cursor < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[cursor])) {
            const content = lines[cursor].replace(/^\s*([-*+]|\d+\.)\s+/, '')
            items.push(h('li', { key: `i${key}-${items.length}` }, inline(content, `i${key}-${items.length}`)))
            cursor += 1
          }
          blocks.push(h(ordered ? 'ol' : 'ul', { key: `b${key++}`, className: 'dsl-md-list' }, items))
          continue
        }

        if (/^\s*$/.test(line)) {
          cursor += 1
          continue
        }

        const buffer = []
        while (
          cursor < lines.length &&
          !/^\s*$/.test(lines[cursor]) &&
          !/^(#{1,6})\s|^```|^>|^\s*([-*+]|\d+\.)\s/.test(lines[cursor])
        ) {
          buffer.push(lines[cursor])
          cursor += 1
        }
        blocks.push(h('p', { key: `b${key++}`, className: 'dsl-md-p' }, inline(buffer.join(' '), `p${key}`)))
      }
      return blocks
    }

    /* ------------------------------------------------------ primitives */

    const Pill = (props) => h('span', { className: `dsl-pill dsl-pill-${props.tone || 'neutral'}` }, props.children)

    function Bar(props) {
      const value = Math.max(0, Math.min(100, Number(props.value) || 0))
      return h('div', { className: 'dsl-bar' }, h('div', { className: 'dsl-bar-fill', style: { width: `${value}%` } }))
    }

    /** The panel cannot call a model, so it hands the learner the exact sentence. */
    function CopyHint(props) {
      const [copied, setCopied] = useState(false)
      return h(
        'span',
        { className: 'dsl-hint' },
        h('span', { className: 'dsl-muted' }, '在对话里说：'),
        h('code', { className: 'dsl-inline-code' }, props.text),
        h(
          'button',
          {
            className: 'dsl-iconbtn',
            title: '复制这句话',
            onClick: () => {
              try {
                navigator.clipboard.writeText(props.text)
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              } catch {
                setCopied(false)
              }
            },
          },
          copied ? '已复制' : '复制',
        ),
      )
    }

    const PanelIcon = (props) => {
      const size = props && props.size ? props.size : 18
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 64 64', 'aria-hidden': true, style: { display: 'block' } },
        h('path', {
          d: 'M8 14a4 4 0 0 1 4-4h14a6 6 0 0 1 6 6 6 6 0 0 1 6-6h14a4 4 0 0 1 4 4v30a4 4 0 0 1-4 4H32a6 6 0 0 0-6 6 6 6 0 0 0-6-6H12a4 4 0 0 1-4-4Z',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 4,
          strokeLinejoin: 'round',
        }),
        h('path', { d: 'M32 16v38', fill: 'none', stroke: 'currentColor', strokeWidth: 4, strokeLinecap: 'round' }),
      )
    }

    const CSS = `
.dsl-root { position:relative; display:flex; flex-direction:column; height:100%; min-height:0; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); font-size:13px; line-height:1.55; }
.dsl-center { align-items:center; justify-content:center; color:var(--dsw-alias-label-secondary); }
.dsl-head { display:flex; align-items:center; gap:18px; flex-wrap:wrap; padding:14px 22px; border-bottom:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); }
.dsl-head-title { min-width:200px; flex:1 1 260px; display:flex; align-items:center; gap:12px; }
.dsl-head-title h1 { margin:0; font-size:16px; font-weight:600; }
.dsl-head-sub { color:var(--dsw-alias-label-secondary); font-size:12px; word-break:break-all; }
.dsl-pills { display:flex; gap:6px; flex-wrap:wrap; }
.dsl-head-actions { display:flex; align-items:center; gap:8px; }
.dsl-busy { color:var(--dsw-alias-label-secondary); font-size:12px; }
.dsl-btn { appearance:none; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); border-radius:6px; padding:5px 11px; font-size:12px; cursor:pointer; font-family:inherit; white-space:nowrap; }
.dsl-btn:hover:not(:disabled) { border-color:var(--dsw-alias-border-l2); }
.dsl-btn:disabled { opacity:.45; cursor:default; }
.dsl-btn-primary { background:var(--dsw-alias-brand-primary); border-color:transparent; color:#fff; }
.dsl-btn-danger:hover:not(:disabled) { color:var(--dsw-alias-state-error-primary); border-color:var(--dsw-alias-state-error-primary); }
.dsl-btn-tiny { padding:2px 7px; font-size:11px; }
.dsl-input, .dsl-select, .dsl-textarea { border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); border-radius:6px; padding:5px 9px; font-size:12px; font-family:inherit; }
.dsl-textarea { width:100%; resize:vertical; min-height:44px; }
.dsl-input:focus, .dsl-select:focus, .dsl-textarea:focus { outline:none; border-color:var(--dsw-alias-brand-primary); }
.dsl-tabs { display:flex; gap:2px; padding:0 18px; border-bottom:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); overflow-x:auto; }
.dsl-tab { appearance:none; border:none; background:transparent; color:var(--dsw-alias-label-secondary); font-family:inherit; font-size:13px; padding:9px 13px; cursor:pointer; border-bottom:2px solid transparent; white-space:nowrap; }
.dsl-tab:hover { color:var(--dsw-alias-label-primary); }
.dsl-tab-active { color:var(--dsw-alias-brand-primary); border-bottom-color:var(--dsw-alias-brand-primary); font-weight:600; }
.dsl-body { flex:1; min-height:0; overflow:auto; padding:18px 22px 40px; }
.dsl-foot { padding:6px 22px 10px; color:var(--dsw-alias-label-secondary); font-size:10.5px; border-top:1px solid var(--dsw-alias-border-l1); }
.dsl-error { margin:0 22px 10px; padding:8px 12px; border-radius:6px; border:1px solid var(--dsw-alias-state-error-primary); color:var(--dsw-alias-state-error-primary); font-size:12px; white-space:pre-wrap; }
.dsl-banner { display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin-bottom:14px; padding:10px 14px; border-radius:8px; border:1px solid var(--dsw-alias-state-warn-primary); color:var(--dsw-alias-state-warn-primary); font-size:12px; }
.dsl-card { border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); border-radius:10px; padding:14px 16px; min-width:0; }
.dsl-card h2 { margin:0 0 10px; font-size:13px; font-weight:600; }
.dsl-card h3 { margin:14px 0 8px; font-size:12px; font-weight:600; color:var(--dsw-alias-label-secondary); }
.dsl-card-head { display:flex; align-items:baseline; justify-content:space-between; gap:12px; }
.dsl-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:14px; align-items:start; }
.dsl-span2 { grid-column:1/-1; }
.dsl-stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(104px,1fr)); gap:10px; margin-top:12px; }
.dsl-stat { border:1px solid var(--dsw-alias-border-l1); border-radius:8px; padding:8px 10px; background:var(--dsw-alias-bg-layer-2); }
.dsl-stat b { display:block; font-size:18px; font-weight:600; }
.dsl-stat span { color:var(--dsw-alias-label-secondary); font-size:11px; }
.dsl-pill { display:inline-flex; align-items:center; border-radius:999px; padding:1px 8px; font-size:11px; border:1px solid var(--dsw-alias-border-l1); color:var(--dsw-alias-label-secondary); white-space:nowrap; }
.dsl-pill-brand { color:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); }
.dsl-pill-success { color:var(--dsw-alias-state-success-primary); border-color:var(--dsw-alias-state-success-primary); }
.dsl-pill-warn { color:var(--dsw-alias-state-warn-primary); border-color:var(--dsw-alias-state-warn-primary); }
.dsl-pill-error { color:var(--dsw-alias-state-error-primary); border-color:var(--dsw-alias-state-error-primary); }
.dsl-bar { height:6px; border-radius:999px; background:var(--dsw-alias-bg-layer-2); border:1px solid var(--dsw-alias-border-l1); overflow:hidden; flex:1; min-width:60px; }
.dsl-bar-fill { height:100%; background:var(--dsw-alias-brand-primary); transition:width .18s ease; }
.dsl-muted { color:var(--dsw-alias-label-secondary); font-size:11px; }
.dsl-hint { display:inline-flex; align-items:center; gap:6px; flex-wrap:wrap; }
.dsl-empty { color:var(--dsw-alias-label-secondary); padding:18px; text-align:center; border:1px dashed var(--dsw-alias-border-l1); border-radius:8px; }
.dsl-cards { display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:14px; align-items:start; }
.dsl-pcard { display:flex; flex-direction:column; gap:9px; text-align:left; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); border-radius:10px; padding:14px 16px; cursor:pointer; color:inherit; font-family:inherit; font-size:13px; }
.dsl-pcard:hover { border-color:var(--dsw-alias-brand-primary); }
.dsl-pcard-active { border-color:var(--dsw-alias-brand-primary); }
.dsl-pcard-top { display:flex; align-items:flex-start; justify-content:space-between; gap:10px; }
.dsl-pcard-title { font-weight:600; font-size:14px; }
.dsl-pcard-goal { color:var(--dsw-alias-label-secondary); font-size:12px; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.dsl-pcard-stats { display:flex; gap:10px; flex-wrap:wrap; color:var(--dsw-alias-label-secondary); font-size:11px; }
.dsl-iconbtn { appearance:none; border:1px solid transparent; background:transparent; color:var(--dsw-alias-label-secondary); border-radius:6px; padding:2px 7px; cursor:pointer; font-family:inherit; font-size:11px; line-height:1.4; }
.dsl-iconbtn:hover { border-color:var(--dsw-alias-border-l1); color:var(--dsw-alias-label-primary); }
.dsl-menu { display:flex; flex-direction:column; gap:8px; padding:10px; border-radius:8px; background:var(--dsw-alias-bg-layer-2); border:1px solid var(--dsw-alias-border-l1); cursor:default; }
.dsl-split { display:grid; grid-template-columns:minmax(250px,330px) minmax(0,1fr); gap:14px; align-items:start; }
.dsl-col { display:flex; flex-direction:column; gap:8px; min-width:0; }
.dsl-list { display:flex; flex-direction:column; gap:6px; }
.dsl-item { display:flex; flex-direction:column; gap:6px; text-align:left; width:100%; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); border-radius:8px; padding:9px 11px; cursor:pointer; color:inherit; font-family:inherit; font-size:12px; }
.dsl-item:hover { border-color:var(--dsw-alias-border-l2); }
.dsl-item-active { border-color:var(--dsw-alias-brand-primary); }
.dsl-item-top { display:flex; align-items:center; justify-content:space-between; gap:8px; }
.dsl-item-title { font-weight:600; font-size:12.5px; }
.dsl-row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.dsl-row-grow { flex:1; min-width:120px; }
.dsl-check { display:flex; align-items:center; gap:9px; padding:7px 9px; border:1px solid var(--dsw-alias-border-l1); border-radius:7px; background:var(--dsw-alias-bg-layer-1); }
.dsl-check input { accent-color:var(--dsw-alias-brand-primary); }
.dsl-check-title { flex:1; min-width:0; }
.dsl-done { text-decoration:line-through; color:var(--dsw-alias-label-secondary); }
.dsl-inline-code { background:var(--dsw-alias-bg-layer-2); border:1px solid var(--dsw-alias-border-l1); border-radius:4px; padding:0 4px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11.5px; }
.dsl-pre { background:var(--dsw-alias-bg-layer-2); border:1px solid var(--dsw-alias-border-l1); border-radius:8px; padding:10px 12px; overflow:auto; margin:0 0 10px; }
.dsl-pre code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11.5px; }
.dsl-md-h { margin:16px 0 8px; line-height:1.3; }
.dsl-md-h1 { font-size:17px; } .dsl-md-h2 { font-size:15px; } .dsl-md-h3 { font-size:13.5px; }
.dsl-md-h4, .dsl-md-h5, .dsl-md-h6 { font-size:12.5px; color:var(--dsw-alias-label-secondary); }
.dsl-md-p { margin:0 0 9px; }
.dsl-md-list { margin:0 0 10px; padding-left:20px; }
.dsl-md-list li { margin:2px 0; }
.dsl-quote { margin:0 0 10px; padding:2px 12px; border-left:2px solid var(--dsw-alias-border-l2); color:var(--dsw-alias-label-secondary); }
.dsl-hr { border:none; border-top:1px solid var(--dsw-alias-border-l1); margin:14px 0; }
.dsl-viewer { position:absolute; inset:0; display:flex; flex-direction:column; background:var(--dsw-alias-bg-base); z-index:2; }
.dsl-viewer-head { display:flex; align-items:center; gap:12px; flex-wrap:wrap; padding:11px 18px; border-bottom:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); }
.dsl-viewer-head h2 { margin:0; font-size:14px; }
.dsl-viewer-body { flex:1; min-height:0; overflow:auto; padding:18px 22px 48px; max-width:900px; }
.dsl-viewer-side { border-top:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); padding:12px 18px; max-height:40%; overflow:auto; }
.dsl-kp { display:flex; flex-direction:column; gap:6px; border:1px solid var(--dsw-alias-border-l1); border-radius:8px; padding:9px 11px; background:var(--dsw-alias-bg-layer-1); }
.dsl-kp-top { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.dsl-kp-name { font-weight:600; font-size:12.5px; flex:1; min-width:100px; }
.dsl-kp-actions { display:flex; gap:4px; flex-wrap:wrap; }
.dsl-stages { display:flex; gap:4px; flex-wrap:wrap; }
.dsl-gate { border:1px solid var(--dsw-alias-state-warn-primary); border-radius:8px; padding:9px 12px; color:var(--dsw-alias-state-warn-primary); font-size:12px; }
.dsl-gate ul { margin:6px 0 0; padding-left:18px; }
.dsl-q { border:1px solid var(--dsw-alias-brand-primary); border-radius:10px; padding:14px 16px; background:var(--dsw-alias-bg-layer-1); }
.dsl-q-prompt { font-size:14px; font-weight:600; margin-bottom:10px; white-space:pre-wrap; }
.dsl-choice { display:flex; align-items:flex-start; gap:9px; padding:8px 10px; border:1px solid var(--dsw-alias-border-l1); border-radius:8px; cursor:pointer; background:var(--dsw-alias-bg-layer-2); }
.dsl-choice input { margin-top:3px; accent-color:var(--dsw-alias-brand-primary); }
.dsl-choice-on { border-color:var(--dsw-alias-brand-primary); }
.dsl-result { border-radius:10px; padding:12px 16px; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); }
.dsl-result-ok { border-color:var(--dsw-alias-state-success-primary); }
.dsl-result-bad { border-color:var(--dsw-alias-state-error-primary); }
.dsl-log { display:flex; flex-direction:column; gap:5px; }
.dsl-log-row { display:flex; gap:10px; align-items:baseline; font-size:12px; }
.dsl-log-time { color:var(--dsw-alias-label-secondary); font-size:11px; white-space:nowrap; }
.dsl-doc-btns { display:flex; gap:8px; flex-wrap:wrap; }
.dsl-form { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:10px; }
.dsl-field { display:flex; flex-direction:column; gap:4px; }
.dsl-field label { font-size:11px; color:var(--dsw-alias-label-secondary); }
.dsl-note { display:flex; gap:10px; align-items:flex-start; border:1px solid var(--dsw-alias-border-l1); border-radius:8px; padding:8px 10px; background:var(--dsw-alias-bg-layer-2); }
.dsl-note-anchor { flex:1; min-width:0; }
.dsl-note-meta { color:var(--dsw-alias-label-secondary); font-size:11px; }
.dsl-steps { display:flex; gap:5px; flex-wrap:wrap; }
`

    /* =================================================== 项目管理页 ==== */

    function ProjectsPage(props) {
      const { state, busy, onOpen, onAction, onCreate } = props
      const [menu, setMenu] = useState(null)
      const [renameDraft, setRenameDraft] = useState('')
      const [confirming, setConfirming] = useState(false)

      const projects = state.projects || []

      const submitRename = async (projectId) => {
        if (!renameDraft.trim()) return
        await onAction({ action: 'project_rename', projectId, title: renameDraft.trim() })
        setMenu(null)
        setConfirming(false)
      }

      return h(
        'div',
        { className: 'dsl-body' },
        state.legacy
          ? h(
              'div',
              { className: 'dsl-banner' },
              h('span', null, `检测到旧的单项目文件直接放在 ${state.root} 下，迁移后会整理成 ${state.root}/<项目名>/。`),
              h('button', { className: 'dsl-btn', disabled: busy, onClick: () => onAction({ action: 'project_migrate' }) }, '迁移'),
            )
          : null,

        h(
          'div',
          { className: 'dsl-cards' },
          projects.map((project) =>
            h(
              'div',
              { key: project.id, className: `dsl-pcard${state.current === project.id ? ' dsl-pcard-active' : ''}` },
              h(
                'div',
                { className: 'dsl-pcard-top', onClick: () => { if (menu !== project.id) onOpen(project.id) } },
                h(
                  'div',
                  { style: { minWidth: 0, flex: 1 } },
                  h('div', { className: 'dsl-pcard-title' }, project.title),
                  project.subject ? h('div', { className: 'dsl-muted' }, project.subject) : null,
                ),
                h(
                  'button',
                  {
                    className: 'dsl-iconbtn',
                    title: '项目操作',
                    onClick: (event) => {
                      event.stopPropagation()
                      setMenu(menu === project.id ? null : project.id)
                      setRenameDraft(project.title)
                      setConfirming(false)
                    },
                  },
                  '⋯',
                ),
              ),

              menu === project.id
                ? h(
                    'div',
                    { className: 'dsl-menu', onClick: (event) => event.stopPropagation() },
                    h(
                      'div',
                      { className: 'dsl-row' },
                      h('input', {
                        className: 'dsl-input dsl-row-grow',
                        value: renameDraft,
                        placeholder: '新名称',
                        onChange: (event) => setRenameDraft(event.target.value),
                        onKeyDown: (event) => { if (event.key === 'Enter') submitRename(project.id) },
                      }),
                      h('button', { className: 'dsl-btn', disabled: busy || !renameDraft.trim(), onClick: () => submitRename(project.id) }, '重命名'),
                    ),
                    h(
                      'div',
                      { className: 'dsl-row' },
                      h('button', { className: 'dsl-btn', disabled: busy, onClick: () => onOpen(project.id) }, '打开'),
                      confirming
                        ? h(
                            'button',
                            {
                              className: 'dsl-btn dsl-btn-danger',
                              disabled: busy,
                              onClick: async () => {
                                await onAction({ action: 'project_remove', projectId: project.id })
                                setMenu(null)
                                setConfirming(false)
                              },
                            },
                            `从列表移除「${project.title}」`,
                          )
                        : h('button', { className: 'dsl-btn dsl-btn-danger', disabled: busy, onClick: () => setConfirming(true) }, '从列表移除'),
                    ),
                    h('span', { className: 'dsl-muted' }, `目录：${project.dir ?? `${state.root}/${project.id}`}`),
                  )
                : null,

              project.missing
                ? h('div', { className: 'dsl-gate' }, `文件夹不见了：${project.dir}`)
                : null,
              project.goal ? h('div', { className: 'dsl-pcard-goal' }, project.goal) : null,
              h(Bar, { value: project.stats.progress }),
              h(
                'div',
                { className: 'dsl-pcard-stats' },
                h('span', null, `${project.stats.progress}%`),
                h('span', null, `章节 ${project.stats.chapters}`),
                h('span', null, `知识点 ${project.stats.knowledgePointsMastered}/${project.stats.knowledgePoints}`),
                h('span', null, `待办 ${project.stats.tasksOpen}`),
                project.standard ? h('span', null, '标准项目') : null,
                project.stats.reviewsDue
                  ? h('span', { style: { color: 'var(--dsw-alias-state-error-primary)' } }, `待复习 ${project.stats.reviewsDue}`)
                  : null,
                project.stats.errorsActive
                  ? h('span', { style: { color: 'var(--dsw-alias-state-warn-primary)' } }, `错题 ${project.stats.errorsActive}`)
                  : null,
                h('span', null, `资料 ${project.stats.materials}`),
                h('span', null, `累计 ${project.stats.minutes} 分钟`),
              ),
              h('div', { className: 'dsl-muted' }, `最近学习：${when(project.stats.lastAt)}`),
            ),
          ),

          h(
            'button',
            {
              className: 'dsl-pcard',
              style: { alignItems: 'center', justifyContent: 'center', minHeight: '132px' },
              disabled: busy,
              onClick: onCreate,
            },
            h('div', { className: 'dsl-pcard-title' }, '＋ 新建学习项目'),
            h('div', { className: 'dsl-muted' }, '选择或新建一个文件夹'),
            h('div', { className: 'dsl-muted' }, '已有 learning.md + learning.json 会被识别为标准项目'),
          ),
        ),

        projects.length === 0
          ? h(
              'div',
              { className: 'dsl-empty', style: { marginTop: '14px' } },
              '还没有学习项目。一个项目就是一个文件夹，点上面的卡片开始；也可以直接让 Agent 用 learning({action:"project_create"}) 创建。',
            )
          : null,
      )
    }

    /* =================================================== 项目详情页 ==== */

    function ProjectDetail(props) {
      const { state, busy, onAction, openDoc, openMaterial, tab, setTab } = props
      const [selected, setSelected] = useState(null)
      const [taskFilter, setTaskFilter] = useState('open')
      const [draftChapter, setDraftChapter] = useState('')
      const [draftTask, setDraftTask] = useState('')
      const [draftKp, setDraftKp] = useState('')
      const [draftKpType, setDraftKpType] = useState('memory')
      const [answer, setAnswer] = useState('')
      const [hintsUsed, setHintsUsed] = useState('0')
      const [errorType, setErrorType] = useState('application')
      const [slider, setSlider] = useState(null)
      const [draftMinutes, setDraftMinutes] = useState('25')
      const [draftNote, setDraftNote] = useState('')
      const [learnerDraft, setLearnerDraft] = useState(null)

      const chapters = state.chapters || []
      const tasks = state.tasks || []
      const materials = state.materials || []
      const stats = state.stats || {}
      const learner = learnerDraft ?? state.learner ?? {}
      const current = chapters.find((chapter) => chapter.id === selected) || chapters[0] || null
      const practice = state.practice ?? { pending: null, attempts: [], errors: [] }
      const queue = (state.review && state.review.queue) || []
      const due = (state.review && state.review.due) || []
      const pending = practice.pending

      const tasksOf = (chapterId) => tasks.filter((task) => task.chapterId === chapterId)
      const chapterTitle = (chapterId) => chapters.find((chapter) => chapter.id === chapterId)?.title || '（未归类）'
      const setLearnerField = (key, value) => setLearnerDraft({ ...learner, [key]: value })

      /* -------------------------------------------------- sub-renders */

      const renderLearner = () =>
        h(
          'section',
          { className: 'dsl-card dsl-span2' },
          h(
            'div',
            { className: 'dsl-card-head' },
            h('h2', null, '学习者画像'),
            h('span', { className: 'dsl-muted' }, learner.updatedAt ? `更新于 ${when(learner.updatedAt)}` : '还没采集'),
          ),
          h(
            'p',
            { className: 'dsl-muted', style: { marginTop: 0 } },
            '只填只有你知道的事。已有基础、目标水平（“能读论文”和“能自己实现”是同科目的两条路）、时间预算，决定大纲的形状和节奏。',
          ),
          h(
            'div',
            { className: 'dsl-form' },
            [
              ['priorKnowledge', '已有的基础'],
              ['targetLevel', '学完想达到什么水平'],
              ['timeBudget', '可用时间（例如：两周，每晚一小时）'],
              ['preferences', '偏好的教法'],
            ].map(([key, label]) =>
              h(
                'div',
                { key, className: 'dsl-field' },
                h('label', null, label),
                h('input', {
                  className: 'dsl-input',
                  value: learner[key] ?? '',
                  onChange: (event) => setLearnerField(key, event.target.value),
                }),
              ),
            ),
            h(
              'div',
              { className: 'dsl-field' },
              h('label', null, '教学策略'),
              h(
                'select',
                {
                  className: 'dsl-select',
                  value: learner.teachingStrategy ?? 'probe_first',
                  onChange: (event) => setLearnerField('teachingStrategy', event.target.value),
                },
                h('option', { value: 'probe_first' }, '先测后教（先诊断再讲）'),
                h('option', { value: 'teach_first' }, '先教后测'),
              ),
            ),
          ),
          h(
            'div',
            { className: 'dsl-row', style: { marginTop: '12px' } },
            h('button', { className: 'dsl-btn dsl-btn-primary', disabled: busy, onClick: () => onAction({ action: 'learner_set', projectId: state.id, learner }) }, '保存画像'),
            learnerDraft ? h('button', { className: 'dsl-btn', disabled: busy, onClick: () => setLearnerDraft(null) }, '撤销修改') : null,
          ),
        )

      const renderLog = () =>
        state.log && state.log.length
          ? h(
              'div',
              { className: 'dsl-log' },
              state.log.slice(0, 12).map((entry) =>
                h(
                  'div',
                  { key: entry.id, className: 'dsl-log-row' },
                  h('span', { className: 'dsl-log-time' }, String(entry.at).slice(5, 16).replace('T', ' ')),
                  h('span', null, entry.kind === 'review' ? '🔁' : entry.kind === 'material' ? '📄' : entry.kind === 'reading' ? '📖' : '📘'),
                  h('span', { className: 'dsl-row-grow' }, entry.note || chapterTitle(entry.chapterId)),
                  entry.minutes ? h('span', { className: 'dsl-muted' }, `${entry.minutes} 分钟`) : null,
                ),
              ),
            )
          : h('div', { className: 'dsl-empty' }, '还没有学习记录。')

      const renderOverview = () =>
        h(
          'div',
          { className: 'dsl-grid' },
          h(
            'section',
            { className: 'dsl-card dsl-span2' },
            h('div', { className: 'dsl-card-head' }, h('h2', null, '掌握度总览'), h('span', { className: 'dsl-muted' }, `${stats.progress || 0}%`)),
            h(Bar, { value: stats.progress || 0 }),
            h(
              'div',
              { className: 'dsl-stats' },
              [
                ['章节', stats.chapters || 0],
                ['已完成', stats.chaptersDone || 0],
                ['被闸门拦住', stats.chaptersBlocked || 0],
                ['知识点', stats.knowledgePoints || 0],
                ['已掌握', stats.knowledgePointsMastered || 0],
                ['到期复习', stats.reviewsDue || 0],
                ['未解决错题', stats.errorsActive || 0],
                ['今日分钟', stats.todayMinutes || 0],
              ].map(([label, value]) =>
                h('div', { key: label, className: 'dsl-stat' }, h('b', null, String(value)), h('span', null, label)),
              ),
            ),
          ),
          renderLearner(),
          h(
            'section',
            { className: 'dsl-card' },
            h('h2', null, '文档'),
            h(
              'div',
              { className: 'dsl-doc-btns' },
              h('button', { className: 'dsl-btn', onClick: () => openDoc('学习计划 learning.md', state.docs.plan) }, '计划'),
              h('button', { className: 'dsl-btn', onClick: () => openDoc('大纲 outline.md', state.docs.outline) }, '大纲'),
              h('button', { className: 'dsl-btn', onClick: () => openDoc('练习题 exercises.md', state.docs.exercises) }, '练习题'),
            ),
          ),
          h(
            'section',
            { className: 'dsl-card' },
            h('h2', null, '记录一次学习'),
            h(
              'div',
              { className: 'dsl-col' },
              h(
                'div',
                { className: 'dsl-row' },
                h('input', {
                  className: 'dsl-input',
                  style: { width: '76px' },
                  value: draftMinutes,
                  inputMode: 'numeric',
                  onChange: (event) => setDraftMinutes(event.target.value),
                }),
                h('span', { className: 'dsl-muted' }, '分钟'),
                h('input', {
                  className: 'dsl-input dsl-row-grow',
                  placeholder: '做了什么（可选）',
                  value: draftNote,
                  onChange: (event) => setDraftNote(event.target.value),
                }),
              ),
              h(
                'button',
                {
                  className: 'dsl-btn dsl-btn-primary',
                  disabled: busy,
                  onClick: async () => {
                    await onAction({
                      action: 'progress_log',
                      projectId: state.id,
                      minutes: Number(draftMinutes) || 0,
                      chapterId: current ? current.id : undefined,
                      note: draftNote,
                    })
                    setDraftNote('')
                  },
                },
                '记录',
              ),
            ),
          ),
          h('section', { className: 'dsl-card dsl-span2' }, h('h2', null, '最近记录'), renderLog()),
          state.plan ? h('section', { className: 'dsl-card dsl-span2' }, h('h2', null, '学习计划'), h('div', null, markdown(state.plan))) : null,
        )

      const renderKp = (point) => {
        const threshold = current.passThreshold || 0.7
        return h(
          'div',
          { key: point.id, className: 'dsl-kp' },
          h(
            'div',
            { className: 'dsl-kp-top' },
            h(Pill, { tone: TYPE_TONE[point.type] || 'neutral' }, TYPE_LABEL[point.type] || point.type),
            h('span', { className: `dsl-kp-name${point.deferred ? ' dsl-done' : ''}` }, point.name),
            point.satisfied ? h(Pill, { tone: 'success' }, '已达标') : h(Pill, { tone: 'warn' }, '未达标'),
            point.deferred ? h(Pill, null, '已跳过') : null,
            point.override && point.override.at ? h(Pill, { tone: 'brand' }, '声明已掌握') : null,
          ),
          point.qualitativeRequired
            ? h(
                'div',
                { className: 'dsl-row' },
                h('span', { className: 'dsl-muted' }, '复述检验：'),
                point.qualitative ? h(Pill, { tone: 'success' }, '已通过') : h(Pill, { tone: 'warn' }, '未通过'),
                h('button', { className: 'dsl-btn dsl-btn-tiny', disabled: busy, onClick: () => onAction({ action: 'assess', projectId: state.id, id: point.id, sufficient: true }) }, '标记通过'),
                h('button', { className: 'dsl-btn dsl-btn-tiny', disabled: busy, onClick: () => onAction({ action: 'assess', projectId: state.id, id: point.id, sufficient: false }) }, '标记未通过'),
              )
            : h(
                'div',
                { className: 'dsl-row' },
                h(Bar, { value: (point.mastery || 0) * (100 / threshold) }),
                h('span', { className: 'dsl-muted' }, `${pct(point.mastery)} / 阈值 ${pct(threshold)} · ${(point.attempts || []).length} 次作答`),
              ),
          h(
            'div',
            { className: 'dsl-kp-actions' },
            h(
              'button',
              {
                className: 'dsl-btn dsl-btn-tiny',
                disabled: busy || (point.attempts || []).length === 0,
                onClick: () => onAction({ action: 'review_grade', projectId: state.id, id: point.id, grade: 'good' }),
              },
              '记为记得',
            ),
            h('button', { className: 'dsl-btn dsl-btn-tiny', disabled: busy, onClick: () => onAction({ action: 'kp_defer', projectId: state.id, id: point.id, deferred: !point.deferred }) }, point.deferred ? '取消跳过' : '跳过'),
            h(
              'button',
              {
                className: 'dsl-btn dsl-btn-tiny',
                disabled: busy,
                onClick: () =>
                  onAction({
                    action: 'kp_override',
                    projectId: state.id,
                    id: point.id,
                    revoke: point.override && point.override.at ? true : undefined,
                    note: '自认为已掌握',
                  }),
              },
              point.override && point.override.at ? '撤销声明' : '声明已掌握',
            ),
            h('button', { className: 'dsl-btn dsl-btn-tiny dsl-btn-danger', disabled: busy, onClick: () => onAction({ action: 'kp_remove', projectId: state.id, id: point.id }) }, '删除'),
          ),
          h(CopyHint, { text: askForQuiz(point.name) }),
        )
      }

      const renderChapterDetail = () => {
        if (current === null) return h('div', { className: 'dsl-empty' }, '先从左侧选择一个章节，或新建一个。')
        const linkedTasks = tasksOf(current.id)
        const linkedMaterials = materials.filter((material) => (material.chapterIds || []).includes(current.id))
        const shown = slider && slider.id === current.id ? slider.value : current.progress
        return h(
          'div',
          { className: 'dsl-col' },
          h(
            'section',
            { className: 'dsl-card' },
            h('h2', null, `${current.order}. ${current.title}`),
            current.objective ? h('p', { className: 'dsl-md-p' }, current.objective) : null,
            h('h3', null, '阶段'),
            h(
              'div',
              { className: 'dsl-stages' },
              STAGES.map((stage) =>
                h(
                  'button',
                  {
                    key: stage,
                    className: `dsl-btn dsl-btn-tiny${current.stage === stage ? ' dsl-btn-primary' : ''}`,
                    disabled: busy,
                    onClick: () => onAction({ action: 'stage_set', projectId: state.id, chapterId: current.id, stage }),
                  },
                  STAGE_LABEL[stage],
                ),
              ),
            ),
            current.gate && !current.gate.passed
              ? h(
                  'div',
                  { className: 'dsl-gate', style: { marginTop: '10px' } },
                  '闸门未通过，不能进入「复习」或「完成」：',
                  h(
                    'ul',
                    null,
                    current.gate.blocked.map((point) =>
                      h(
                        'li',
                        { key: point.id },
                        `${point.name} — ${point.reason === 'needs-qualitative-check' ? '需要复述检验通过' : `掌握度 ${pct(point.mastery)} < 阈值 ${pct(point.threshold)}`}`,
                      ),
                    ),
                  ),
                )
              : h(
                  'div',
                  { className: 'dsl-muted', style: { marginTop: '8px' } },
                  current.gate && current.gate.total > 0 ? '闸门已通过，可以进入复习或完成。' : '还没有知识点，闸门默认通过。',
                ),
            h('h3', null, '进度'),
            h('div', { className: 'dsl-row' }, h('span', { className: 'dsl-muted' }, `${shown}%`)),
            h(
              'div',
              { className: 'dsl-row' },
              h('input', { className: 'dsl-slider', type: 'range', min: 0, max: 100, value: shown, disabled: true }),
              h('span', { className: 'dsl-muted' }, '进度由知识点掌握度派生，不接受手动声明的数字'),
            ),
          ),
          h(
            'section',
            { className: 'dsl-card' },
            h('h2', null, `知识点（${(current.knowledgePoints || []).length}）`),
            h(
              'div',
              { className: 'dsl-row', style: { marginBottom: '10px' } },
              h('input', { className: 'dsl-input dsl-row-grow', placeholder: '新知识点名称', value: draftKp, onChange: (event) => setDraftKp(event.target.value) }),
              h(
                'select',
                { className: 'dsl-select', value: draftKpType, onChange: (event) => setDraftKpType(event.target.value) },
                Object.keys(TYPE_LABEL).map((type) => h('option', { key: type, value: type }, TYPE_LABEL[type])),
              ),
              h(
                'button',
                {
                  className: 'dsl-btn',
                  disabled: busy || !draftKp.trim(),
                  onClick: async () => {
                    await onAction({ action: 'kp_upsert', projectId: state.id, chapterId: current.id, kp: { name: draftKp.trim(), type: draftKpType } })
                    setDraftKp('')
                  },
                },
                '添加',
              ),
            ),
            (current.knowledgePoints || []).length === 0
              ? h('div', { className: 'dsl-empty' }, '还没有知识点。可以让 Agent 依据资料拆出知识点，也可以在这里手动添加。')
              : h('div', { className: 'dsl-list' }, current.knowledgePoints.map(renderKp)),
          ),
          h(
            'section',
            { className: 'dsl-card' },
            h('h2', null, `任务（${linkedTasks.length}）`),
            linkedTasks.length
              ? h(
                  'div',
                  { className: 'dsl-list' },
                  linkedTasks.map((task) =>
                    h(
                      'label',
                      { key: task.id, className: 'dsl-check' },
                      h('input', {
                        type: 'checkbox',
                        checked: task.status === 'done',
                        disabled: busy,
                        onChange: (event) => onAction({ action: 'task_update', projectId: state.id, id: task.id, patch: { status: event.target.checked ? 'done' : 'todo' } }),
                      }),
                      h('span', { className: `dsl-check-title${task.status === 'done' ? ' dsl-done' : ''}` }, task.title),
                    ),
                  ),
                )
              : h('div', { className: 'dsl-muted' }, '该章节还没有任务。'),
          ),
          h(
            'section',
            { className: 'dsl-card' },
            h('h2', null, `资料（${linkedMaterials.length}）`),
            linkedMaterials.length
              ? h(
                  'div',
                  { className: 'dsl-list' },
                  linkedMaterials.map((material) =>
                    h(
                      'button',
                      { key: material.id, className: 'dsl-item', onClick: () => openMaterial(material) },
                      h('div', { className: 'dsl-item-top' }, h('span', { className: 'dsl-item-title' }, material.title), h('span', { className: 'dsl-muted' }, material.kind)),
                      h('span', { className: 'dsl-muted' }, material.source),
                    ),
                  ),
                )
              : h('div', { className: 'dsl-muted' }, '该章节还没有关联资料。'),
          ),
        )
      }

      const renderChapters = () =>
        h(
          'div',
          { className: 'dsl-split' },
          h(
            'div',
            { className: 'dsl-col' },
            h(
              'div',
              { className: 'dsl-row' },
              h('input', { className: 'dsl-input dsl-row-grow', placeholder: '新章节标题', value: draftChapter, onChange: (event) => setDraftChapter(event.target.value) }),
              h(
                'button',
                {
                  className: 'dsl-btn',
                  disabled: busy || !draftChapter.trim(),
                  onClick: async () => {
                    const created = await onAction({ action: 'chapter_upsert', projectId: state.id, chapter: { title: draftChapter.trim() } })
                    if (created && created.chapter) setSelected(created.chapter.id)
                    setDraftChapter('')
                  },
                },
                '添加',
              ),
            ),
            chapters.length === 0
              ? h('div', { className: 'dsl-empty' }, '还没有章节。可以让 Agent 依据资料生成大纲并建章节，也可以在这里手动添加。')
              : h(
                  'div',
                  { className: 'dsl-list' },
                  chapters.map((chapter) =>
                    h(
                      'button',
                      {
                        key: chapter.id,
                        className: `dsl-item${current && current.id === chapter.id ? ' dsl-item-active' : ''}`,
                        onClick: () => setSelected(chapter.id),
                      },
                      h(
                        'div',
                        { className: 'dsl-item-top' },
                        h('span', { className: 'dsl-item-title' }, `${chapter.order}. ${chapter.title}`),
                        h(Pill, { tone: chapter.gate && chapter.gate.passed ? 'success' : 'warn' }, chapter.stageLabel || chapter.stage),
                      ),
                      h(Bar, { value: chapter.progress }),
                      h(
                        'span',
                        { className: 'dsl-muted' },
                        `${chapter.progress}% · 知识点 ${(chapter.knowledgePoints || []).length}${chapter.gate && !chapter.gate.passed ? ` · 拦住 ${chapter.gate.blocked.length}` : ''}`,
                      ),
                    ),
                  ),
                ),
          ),
          h('div', { className: 'dsl-col' }, renderChapterDetail()),
        )

      const renderPractice = () => {
        const submitAnswer = async () => {
          if (!answer.trim()) return
          await onAction({ action: 'quiz_answer', projectId: state.id, answer, hintsUsed: Number(hintsUsed) || 0, errorType })
          setAnswer('')
          setHintsUsed('0')
        }
        return h(
          'div',
          { className: 'dsl-col' },

          pending
            ? pending.status === 'awaiting_input'
              ? h(
                  'div',
                  { className: 'dsl-q' },
                  h('div', { className: 'dsl-muted' }, `待作答 · ${pending.type === 'choice' ? '选择题' : pending.type === 'numeric' ? '数值题' : pending.type === 'boolean' ? '判断题' : '简答题'}`),
                  h('div', { className: 'dsl-q-prompt' }, pending.prompt),
                  (pending.options || []).length > 0
                    ? h(
                        'div',
                        { className: 'dsl-col' },
                        pending.options.map((option) =>
                          h(
                            'label',
                            { key: option.label, className: `dsl-choice${answer === option.label ? ' dsl-choice-on' : ''}` },
                            h('input', { type: 'radio', name: 'dsl-answer', checked: answer === option.label, onChange: () => setAnswer(option.label) }),
                            h('span', null, h('b', null, `${option.label}. `), option.body),
                          ),
                        ),
                      )
                    : h('textarea', { className: 'dsl-textarea', placeholder: '写下你的答案', value: answer, onChange: (event) => setAnswer(event.target.value) }),
                  h(
                    'div',
                    { className: 'dsl-row', style: { marginTop: '10px' } },
                    h('span', { className: 'dsl-muted' }, '用了几次提示'),
                    h('input', { className: 'dsl-input', style: { width: '56px' }, value: hintsUsed, inputMode: 'numeric', onChange: (event) => setHintsUsed(event.target.value) }),
                    h(
                      'select',
                      { className: 'dsl-select', value: errorType, onChange: (event) => setErrorType(event.target.value) },
                      Object.keys(ERROR_LABEL).map((type) => h('option', { key: type, value: type }, ERROR_LABEL[type])),
                    ),
                    h('button', { className: 'dsl-btn dsl-btn-primary', disabled: busy || !answer.trim(), onClick: submitAnswer }, '提交答案'),
                    h('button', { className: 'dsl-btn', disabled: busy, onClick: () => onAction({ action: 'quiz_skip', projectId: state.id }) }, '放弃这题'),
                  ),
                )
              : h(
                  'div',
                  { className: `dsl-result ${pending.result && pending.result.isCorrect ? 'dsl-result-ok' : 'dsl-result-bad'}` },
                  h('div', { className: 'dsl-q-prompt' }, pending.result && pending.result.isCorrect ? '✅ 答对了' : '❌ 答错了'),
                  h('div', { className: 'dsl-md-p' }, h('b', null, '你的答案：'), pending.result ? pending.result.yourAnswer || '（空）' : ''),
                  h('div', { className: 'dsl-md-p' }, h('b', null, '正确答案：'), pending.result ? pending.result.expectedAnswer : ''),
                  pending.result && pending.result.explanation ? h('div', { className: 'dsl-md-p' }, h('b', null, '解析：'), pending.result.explanation) : null,
                  h('div', { className: 'dsl-muted' }, '掌握度与复习排期已按这个结果更新。要下一题，在对话里说一句。'),
                )
            : h(
                'div',
                { className: 'dsl-empty' },
                '现在没有待作答的题。让 Agent 针对某个知识点出题，答完这里会显示对错、正解和解析 —— 评分由 Host 的确定性引擎完成，答案不回传给模型。',
              ),

          h(
            'section',
            { className: 'dsl-card' },
            h(
              'div',
              { className: 'dsl-card-head' },
              h('h2', null, '今天练什么'),
              h('span', { className: 'dsl-muted' }, `到期 ${due.length} · 错题 ${(practice.errors || []).length}`),
            ),
            h('h3', null, '到期复习'),
            due.length === 0
              ? h('div', { className: 'dsl-muted' }, '今天没有到期的复习。')
              : h(
                  'div',
                  { className: 'dsl-list' },
                  due.map((task) =>
                    h(
                      'div',
                      { key: task.id, className: 'dsl-kp' },
                      h(
                        'div',
                        { className: 'dsl-kp-top' },
                        h('span', { className: 'dsl-kp-name' }, task.name || task.knowledgePointId),
                        h(Pill, { tone: 'error' }, `风险 ${pct(task.forgettingRisk)}`),
                      ),
                      h('div', { className: 'dsl-muted' }, task.reason),
                      h(
                        'div',
                        { className: 'dsl-row' },
                        h(CopyHint, { text: askForQuiz(task.name || '这个知识点') }),
                        Object.keys(GRADE_LABEL).map((grade) =>
                          h(
                            'button',
                            { key: grade, className: 'dsl-btn dsl-btn-tiny', disabled: busy, onClick: () => onAction({ action: 'review_grade', projectId: state.id, id: task.knowledgePointId, grade }) },
                            GRADE_LABEL[grade],
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
            h('h3', null, '最弱的知识点'),
            (stats.weakestPoints || []).length === 0
              ? h('div', { className: 'dsl-muted' }, '没有待攻克的知识点。')
              : h(
                  'div',
                  { className: 'dsl-list' },
                  (stats.weakestPoints || []).map((point) =>
                    h(
                      'div',
                      { key: point.id, className: 'dsl-kp' },
                      h(
                        'div',
                        { className: 'dsl-kp-top' },
                        h(Pill, { tone: TYPE_TONE[point.type] || 'neutral' }, TYPE_LABEL[point.type] || point.type),
                        h('span', { className: 'dsl-kp-name' }, point.name),
                        h('span', { className: 'dsl-muted' }, pct(point.mastery)),
                      ),
                      h(Bar, { value: (point.mastery || 0) * 100 }),
                      h(CopyHint, { text: askForQuiz(point.name) }),
                    ),
                  ),
                ),
            h('h3', null, '未解决的错题'),
            (practice.errors || []).length === 0
              ? h('div', { className: 'dsl-muted' }, '没有未解决的错题。')
              : h(
                  'div',
                  { className: 'dsl-list' },
                  (practice.errors || []).map((error) =>
                    h(
                      'div',
                      { key: error.id, className: 'dsl-kp' },
                      h(
                        'div',
                        { className: 'dsl-kp-top' },
                        h(Pill, { tone: 'error' }, ERROR_LABEL[error.errorType] || error.errorType),
                        h('span', { className: 'dsl-kp-name' }, error.knowledgePointName || error.knowledgePointId),
                        h(Pill, null, ERROR_STATUS_LABEL[error.status] || error.status),
                      ),
                      h('div', { className: 'dsl-muted' }, `重试 ${(error.retryHistory || []).length} 次${error.selfAttribution ? ` · ${error.selfAttribution}` : ''}`),
                    ),
                  ),
                ),
            h('h3', null, '被闸门拦住的章节'),
            (stats.gateBlocked || []).length === 0
              ? h('div', { className: 'dsl-muted' }, '没有被拦住的章节。')
              : h(
                  'div',
                  { className: 'dsl-list' },
                  (stats.gateBlocked || []).map((chapter) =>
                    h(
                      'div',
                      { key: chapter.chapterId, className: 'dsl-kp' },
                      h(
                        'div',
                        { className: 'dsl-kp-top' },
                        h('span', { className: 'dsl-kp-name' }, chapter.title),
                        h(Pill, { tone: 'warn' }, STAGE_LABEL[chapter.stage] || chapter.stage),
                      ),
                      h('div', { className: 'dsl-muted' }, chapter.blocked.map((point) => `${point.name}(${pct(point.mastery)})`).join('、')),
                    ),
                  ),
                ),
          ),

          h(
            'section',
            { className: 'dsl-card' },
            h('h2', null, `出题记录（${(practice.attempts || []).length}）`),
            (practice.attempts || []).length === 0
              ? h('div', { className: 'dsl-muted' }, '还没有作答记录。')
              : h(
                  'div',
                  { className: 'dsl-list' },
                  (practice.attempts || []).map((attempt) =>
                    h(
                      'div',
                      { key: attempt.id, className: 'dsl-check' },
                      h('span', null, attempt.isCorrect ? '✅' : '❌'),
                      h('span', { className: 'dsl-check-title' }, attempt.prompt),
                      h('span', { className: 'dsl-muted' }, `${attempt.knowledgePointName || ''} · ${attempt.matchedBy || ''} · ${when(attempt.gradedAt)}`),
                    ),
                  ),
                ),
          ),
        )
      }

      const renderMaterials = () =>
        materials.length === 0
          ? h('div', { className: 'dsl-empty' }, '还没有资料。把文件拖进对话，让 Agent 解析成 markdown 后调用 learning 工具落盘。')
          : h(
              'div',
              { className: 'dsl-list' },
              materials.map((material) =>
                h(
                  'button',
                  { key: material.id, className: 'dsl-item', onClick: () => openMaterial(material) },
                  h(
                    'div',
                    { className: 'dsl-item-top' },
                    h('span', { className: 'dsl-item-title' }, material.title),
                    h('span', { className: 'dsl-muted' }, `${material.kind} · ${material.chars} 字`),
                  ),
                  h(Bar, { value: ((material.reading && material.reading.furthestPercent) || 0) * 100 }),
                  h(
                    'span',
                    { className: 'dsl-muted' },
                    `${material.source} · 读到 ${pct((material.reading && material.reading.furthestPercent) || 0)} · 笔记 ${(material.notes || []).length}`,
                  ),
                ),
              ),
            )

      const renderReviews = () =>
        h(
          'div',
          { className: 'dsl-col' },
          h(
            'div',
            { className: 'dsl-card-head' },
            h('h2', { className: 'dsl-md-h dsl-md-h3', style: { margin: 0 } }, `复习队列（${queue.length}）`),
            h('span', { className: 'dsl-muted' }, `目标可提取性 ${pct(state.desiredRetention)}`),
          ),
          queue.length === 0
            ? h('div', { className: 'dsl-empty' }, '复习队列是空的。通过测验或复述检验推进知识点后会自动排期。')
            : h(
                'div',
                { className: 'dsl-list' },
                queue.map((task) =>
                  h(
                    'div',
                    { key: task.id, className: 'dsl-kp' },
                    h(
                      'div',
                      { className: 'dsl-kp-top' },
                      h(Pill, { tone: TYPE_TONE[task.knowledgeType] || 'neutral' }, TYPE_LABEL[task.knowledgeType] || task.knowledgeType),
                      h('span', { className: 'dsl-kp-name' }, task.name || task.knowledgePointId),
                      h(Pill, { tone: task.overdueDays > 0 ? 'error' : 'neutral' }, `风险 ${pct(task.forgettingRisk)}`),
                      task.hasError ? h(Pill, { tone: 'warn' }, '有错题') : null,
                    ),
                    h('div', { className: 'dsl-muted' }, task.reason),
                    h(
                      'div',
                      { className: 'dsl-muted' },
                      `可提取性 ${pct(task.state && task.state.retrievability)} · 稳定性 ${task.state && task.state.stability ? task.state.stability.toFixed(1) : '?'} 天 · 难度 ${task.state && task.state.difficulty ? task.state.difficulty.toFixed(2) : '?'} · 下次 ${when(task.dueAt)}`,
                    ),
                    h(
                      'div',
                      { className: 'dsl-row' },
                      h(CopyHint, { text: askForQuiz(task.name || '这个知识点') }),
                      Object.keys(GRADE_LABEL).map((grade) =>
                        h(
                          'button',
                          { key: grade, className: 'dsl-btn dsl-btn-tiny', disabled: busy, onClick: () => onAction({ action: 'review_grade', projectId: state.id, id: task.knowledgePointId, grade, minutes: 2 }) },
                          GRADE_LABEL[grade],
                        ),
                      ),
                    ),
                  ),
                ),
              ),
        )

      const renderTasks = () => {
        const filtered = tasks.filter((task) => {
          if (taskFilter === 'open') return task.status !== 'done'
          if (taskFilter === 'done') return task.status === 'done'
          return true
        })
        return h(
          'div',
          { className: 'dsl-col' },
          h(
            'div',
            { className: 'dsl-row' },
            h(
              'select',
              { className: 'dsl-select', value: taskFilter, onChange: (event) => setTaskFilter(event.target.value) },
              h('option', { value: 'open' }, '未完成'),
              h('option', { value: 'done' }, '已完成'),
              h('option', { value: 'all' }, '全部'),
            ),
            h('input', { className: 'dsl-input dsl-row-grow', placeholder: '新任务标题', value: draftTask, onChange: (event) => setDraftTask(event.target.value) }),
            h(
              'button',
              {
                className: 'dsl-btn',
                disabled: busy || !draftTask.trim(),
                onClick: async () => {
                  await onAction({ action: 'task_add', projectId: state.id, task: { title: draftTask.trim(), chapterId: current ? current.id : null } })
                  setDraftTask('')
                },
              },
              '添加',
            ),
          ),
          filtered.length === 0
            ? h('div', { className: 'dsl-empty' }, '没有符合条件的任务。')
            : h(
                'div',
                { className: 'dsl-list' },
                filtered.map((task) =>
                  h(
                    'div',
                    { key: task.id, className: 'dsl-check' },
                    h('input', {
                      type: 'checkbox',
                      checked: task.status === 'done',
                      disabled: busy,
                      onChange: (event) => onAction({ action: 'task_update', projectId: state.id, id: task.id, patch: { status: event.target.checked ? 'done' : 'todo' } }),
                    }),
                    h(
                      'span',
                      { className: 'dsl-check-title' },
                      h('span', { className: task.status === 'done' ? 'dsl-done' : '' }, task.title),
                      task.chapterTitle ? h('span', { className: 'dsl-muted' }, ` · ${task.chapterTitle}`) : null,
                    ),
                    task.priority === 'high' ? h(Pill, { tone: 'error' }, '高') : null,
                    task.due ? h('span', { className: 'dsl-muted' }, task.due) : null,
                    h('button', { className: 'dsl-btn dsl-btn-tiny dsl-btn-danger', disabled: busy, onClick: () => onAction({ action: 'task_remove', projectId: state.id, id: task.id }) }, '删除'),
                  ),
                ),
              ),
        )
      }

      return h(
        'div',
        { className: 'dsl-body' },
        !state.exists
          ? h('div', { className: 'dsl-empty' }, `这个项目还没有 learning.json：${state.root}/${state.id}`)
          : tab === 'overview'
            ? renderOverview()
            : tab === 'chapters'
              ? renderChapters()
              : tab === 'practice'
                ? renderPractice()
                : tab === 'materials'
                  ? renderMaterials()
                  : tab === 'reviews'
                    ? renderReviews()
                    : renderTasks(),
      )
    }

    /* =================================================== 新建项目向导 ==== */

    const WIZARD_STEPS = ['选择文件夹', '识别', '目标与画像', '选择资料', '完成']

    function ProjectWizard(props) {
      const { busy, call, onFinish, onCancel } = props
      const [step, setStep] = useState(0)
      const [dir, setDir] = useState('')
      const [scan, setScan] = useState(null)
      const [title, setTitle] = useState('')
      const [goal, setGoal] = useState('')
      const [learner, setLearner] = useState({
        priorKnowledge: '',
        targetLevel: '',
        timeBudget: '',
        preferences: '',
        teachingStrategy: 'probe_first',
        notes: '',
      })
      const [picked, setPicked] = useState({})
      const [urls, setUrls] = useState('')
      const [uploads, setUploads] = useState([])
      const [note, setNote] = useState(null)
      const [result, setResult] = useState(null)

      const setLearnerField = (key, value) => setLearner({ ...learner, [key]: value })
      const baseName = (path) => String(path ?? '').replace(/[/\\]+$/, '').split(/[/\\]/).pop() || ''

      const rescan = async (target) => {
        const scanned = await call({ action: 'project_scan', dir: target })
        if (scanned === null) return
        setScan(scanned)
        if (!title.trim()) setTitle(baseName(scanned.dir))
        setNote(null)
        setStep(1)
      }

      const chooseFolder = async () => {
        const picker = uiWorkspace && typeof uiWorkspace.pickDirectory === 'function' ? uiWorkspace : null
        if (picker === null) {
          setNote('这个客户端没有目录选择器，请手动填写文件夹路径。')
          return
        }
        try {
          const chosen = await picker.pickDirectory()
          if (!chosen) return
          setDir(chosen)
          if (!title.trim()) setTitle(baseName(chosen))
          await rescan(chosen)
        } catch (cause) {
          setNote(`目录选择器不可用：${message(cause)}`)
        }
      }

      const readUploads = async (event) => {
        const files = Array.from((event.target && event.target.files) || [])
        const read = []
        for (const file of files) {
          try {
            read.push({ name: file.name, title: file.name.replace(/\.[^.]+$/, ''), markdown: await file.text() })
          } catch {
            /* unreadable file: skipped, the summary reports what actually landed */
          }
        }
        if (read.length > 0) setUploads([...uploads, ...read])
      }

      const build = async () => {
        const created = await call({
          action: 'project_create',
          dir: dir.trim() || undefined,
          title: title.trim() || undefined,
          goal: goal.trim() || undefined,
        })
        if (created === null) return
        const projectId = created.project.id
        const hasIntake = ['priorKnowledge', 'targetLevel', 'timeBudget', 'preferences', 'notes'].some(
          (key) => String(learner[key] ?? '').trim() !== '',
        )
        if (hasIntake) await call({ action: 'learner_set', projectId, learner })

        const rels = Object.keys(picked).filter((rel) => picked[rel])
        let imported = []
        if (rels.length > 0) {
          const outcome = await call({ action: 'project_import_files', projectId, rels })
          imported = outcome === null ? [] : outcome.imported
        }

        const added = []
        for (const file of uploads) {
          const outcome = await call({
            action: 'material_add',
            projectId,
            title: file.title,
            markdown: file.markdown,
            source: `upload:${file.name}`,
            kind: 'file',
          })
          if (outcome !== null) added.push({ title: outcome.material.title, chars: outcome.material.chars })
        }

        const fetched = []
        const failed = []
        for (const raw of urls.split('\n').map((line) => line.trim()).filter((line) => line !== '')) {
          const outcome = await call({ action: 'material_fetch', projectId, url: raw })
          if (outcome === null) failed.push(raw)
          else fetched.push({ url: raw, title: outcome.material.title, chars: outcome.chars })
        }

        setResult({ created, imported, added, fetched, failed })
        setStep(4)
      }

      const handoff = `依据「${title.trim() || '这个项目'}」里的资料生成学习大纲：先 chapter_upsert 建章节（带 objective），再为每章 kp_upsert 拆出知识点并标注 type（memory/concept/procedure/design），最后 outline_write 写大纲。`

      const scannedFiles = scan && Array.isArray(scan.files) ? scan.files : []
      const textFiles = scannedFiles.filter((file) => file.kind === 'text')
      const binaryFiles = scannedFiles.filter((file) => file.kind === 'binary')
      const pickedCount = Object.keys(picked).filter((rel) => picked[rel]).length

      const stepBody = () => {
        if (step === 0) {
          return h(
            'div',
            { className: 'dsl-col' },
            h('p', { className: 'dsl-muted', style: { marginTop: 0 } }, '一个学习项目就是一个普通文件夹。可以新建一个，也可以关联已有的文件夹。'),
            h(
              'p',
              { className: 'dsl-muted', style: { marginTop: 0 } },
              '如果这个文件夹里同时有 learning.md 和 learning.json，它就是一个「标准 DashinLearning 项目」，会直接接管，不会改动任何文件。',
            ),
            h(
              'div',
              { className: 'dsl-row' },
              h('button', { className: 'dsl-btn dsl-btn-primary', disabled: busy, onClick: chooseFolder }, '选择文件夹…'),
              h(
                'button',
                { className: 'dsl-btn', disabled: busy, onClick: () => { setDir(''); setScan(null); setStep(1) } },
                '用默认位置（工作区 learning/）',
              ),
            ),
            h(
              'div',
              { className: 'dsl-row' },
              h('input', {
                className: 'dsl-input dsl-row-grow',
                placeholder: '或手动输入文件夹绝对路径，例如 /Users/me/notes/线性代数',
                value: dir,
                onChange: (event) => setDir(event.target.value),
                onKeyDown: (event) => { if (event.key === 'Enter' && dir.trim()) rescan(dir.trim()) },
              }),
              h('button', { className: 'dsl-btn', disabled: busy || !dir.trim(), onClick: () => rescan(dir.trim()) }, '识别'),
            ),
            note ? h('div', { className: 'dsl-gate' }, note) : null,
            h('div', { className: 'dsl-muted' }, '创建后这个文件夹会同时注册成 DSH 工作区，出现在左侧的工作区列表里。'),
          )
        }

        if (step === 1) {
          return h(
            'div',
            { className: 'dsl-col' },
            dir.trim() === ''
              ? h('div', { className: 'dsl-gate' }, `将在工作区下新建一个文件夹：learning/${title.trim() || '<项目名>'}`)
              : h(
                  'div',
                  {
                    className: 'dsl-gate',
                    style: scan && scan.isStandard ? { borderColor: 'var(--dsw-alias-state-success-primary)', color: 'var(--dsw-alias-state-success-primary)' } : null,
                  },
                  scan ? scan.note : '未识别',
                  h('div', { className: 'dsl-muted', style: { marginTop: '6px' } }, dir),
                ),
            scan && scan.isStandard
              ? h('div', { className: 'dsl-muted' }, `已找到 learning.md 与 learning.json，将接管这个项目（${scannedFiles.length} 个可识别文件保持不变）。`)
              : null,
            textFiles.length > 0
              ? h(
                  'div',
                  null,
                  h('h3', null, `文件夹里的文本文件（${textFiles.length}）—— 勾选后导入为学习资料`),
                  h(
                    'div',
                    { className: 'dsl-list' },
                    textFiles.map((file) =>
                      h(
                        'label',
                        { key: file.rel, className: 'dsl-check' },
                        h('input', {
                          type: 'checkbox',
                          checked: picked[file.rel] === true,
                          onChange: () => setPicked({ ...picked, [file.rel]: !picked[file.rel] }),
                        }),
                        h('span', { className: 'dsl-check-title' }, file.rel),
                        h('span', { className: 'dsl-muted' }, `${Math.max(1, Math.round(file.size / 1024))} KB`),
                      ),
                    ),
                  ),
                )
              : null,
            binaryFiles.length > 0
              ? h(
                  'div',
                  null,
                  h('h3', null, `需要 Agent 解析的文件（${binaryFiles.length}）`),
                  h('div', { className: 'dsl-muted' }, binaryFiles.map((file) => file.rel).join('、')),
                  h('div', { className: 'dsl-muted' }, '这些是二进制文档，插件不解析。把它们拖进对话，让 Agent 读出来再 material_add 落盘。'),
                )
              : null,
            scan && !scan.isStandard && textFiles.length === 0 && binaryFiles.length === 0
              ? h('div', { className: 'dsl-muted' }, '文件夹里没有可识别的资料文件，下一步可以直接给目标。')
              : null,
            h(
              'div',
              { className: 'dsl-row', style: { marginTop: '6px' } },
              h('button', { className: 'dsl-btn', disabled: busy, onClick: () => setStep(0) }, '← 上一步'),
              h('button', { className: 'dsl-btn dsl-btn-primary', disabled: busy, onClick: () => setStep(2) }, '下一步'),
            ),
          )
        }

        if (step === 2) {
          return h(
            'div',
            { className: 'dsl-col' },
            h(
              'div',
              { className: 'dsl-form' },
              h('div', { className: 'dsl-field' }, h('label', null, '项目名称'), h('input', {
                className: 'dsl-input', value: title, onChange: (event) => setTitle(event.target.value),
              })),
              h('div', { className: 'dsl-field' }, h('label', null, '学习目标'), h('input', {
                className: 'dsl-input', placeholder: '学完之后能做到什么', value: goal,
                onChange: (event) => setGoal(event.target.value),
              })),
              h('div', { className: 'dsl-field' }, h('label', null, '已有的基础'), h('input', {
                className: 'dsl-input', value: learner.priorKnowledge,
                onChange: (event) => setLearnerField('priorKnowledge', event.target.value),
              })),
              h('div', { className: 'dsl-field' }, h('label', null, '学完想达到什么水平'), h('input', {
                className: 'dsl-input', value: learner.targetLevel,
                onChange: (event) => setLearnerField('targetLevel', event.target.value),
              })),
              h('div', { className: 'dsl-field' }, h('label', null, '可用时间'), h('input', {
                className: 'dsl-input', placeholder: '例如：两周，每晚一小时', value: learner.timeBudget,
                onChange: (event) => setLearnerField('timeBudget', event.target.value),
              })),
              h('div', { className: 'dsl-field' }, h('label', null, '偏好的教法'), h('input', {
                className: 'dsl-input', value: learner.preferences,
                onChange: (event) => setLearnerField('preferences', event.target.value),
              })),
              h('div', { className: 'dsl-field' }, h('label', null, '教学策略'), h('select', {
                className: 'dsl-select', value: learner.teachingStrategy,
                onChange: (event) => setLearnerField('teachingStrategy', event.target.value),
              },
                h('option', { value: 'probe_first' }, '先测后教（先诊断再讲）'),
                h('option', { value: 'teach_first' }, '先教后测'),
              )),
            ),
            h('div', { className: 'dsl-muted' }, '这些都是可选的；填得越具体，Agent 生成的大纲越贴合你的起点和时间。'),
            h(
              'div',
              { className: 'dsl-row' },
              h('button', { className: 'dsl-btn', disabled: busy, onClick: () => setStep(1) }, '← 上一步'),
              h('button', { className: 'dsl-btn dsl-btn-primary', disabled: busy || !title.trim(), onClick: () => setStep(3) }, '下一步'),
            ),
          )
        }

        if (step === 3) {
          return h(
            'div',
            { className: 'dsl-col' },
            h('h3', { style: { marginTop: 0 } }, '资料（可以全部跳过，之后随时补）'),
            h(
              'div',
              { className: 'dsl-card' },
              h('h2', null, `① 文件夹里的文本文件（已选 ${pickedCount}）`),
              scannedFiles.length === 0
                ? h('div', { className: 'dsl-muted' }, '没有扫描到文件。')
                : h('div', { className: 'dsl-muted' }, '在「上一步」里勾选。'),
            ),
            h(
              'div',
              { className: 'dsl-card' },
              h('h2', null, `② 上传本地文件（${uploads.length}）`),
              h('input', {
                className: 'dsl-input', type: 'file', multiple: true,
                accept: '.md,.markdown,.txt,.text,.rst,.org',
                onChange: readUploads,
              }),
              h('div', { className: 'dsl-muted' }, '只接受纯文本类（.md/.txt/.rst/.org）。PDF、Word 请拖进对话让 Agent 解析。'),
              uploads.length > 0
                ? h('div', { className: 'dsl-row' }, uploads.map((file) =>
                    h(Pill, { key: file.name, tone: 'brand' }, `${file.title} · ${file.markdown.length} 字`),
                  ))
                : null,
            ),
            h(
              'div',
              { className: 'dsl-card' },
              h('h2', null, '③ 从网络抓取（每行一个 URL）'),
              h('textarea', {
                className: 'dsl-textarea',
                placeholder: 'https://example.com/docs/…',
                value: urls,
                onChange: (event) => setUrls(event.target.value),
              }),
              h('div', { className: 'dsl-muted' }, 'Host 会用当前 profile 的网页抓取提供者取回页面，HTML 转成 markdown 后落盘。'),
            ),
            h(
              'div',
              { className: 'dsl-row' },
              h('button', { className: 'dsl-btn', disabled: busy, onClick: () => setStep(2) }, '← 上一步'),
              h(
                'button',
                { className: 'dsl-btn dsl-btn-primary', disabled: busy || !title.trim(), onClick: build },
                busy ? '正在创建…' : '创建项目并导入',
              ),
            ),
          )
        }

        const created = result && result.created
        return h(
          'div',
          { className: 'dsl-col' },
          h(
            'div',
            { className: 'dsl-result dsl-result-ok' },
            h('div', { className: 'dsl-q-prompt' }, created && created.adopted ? '✅ 已接管这个标准 DashinLearning 项目' : '✅ 项目已创建'),
            created ? h('div', { className: 'dsl-md-p' }, h('b', null, '位置：'), created.project.dir) : null,
            created && created.project.workspace && created.project.workspace.id
              ? h('div', { className: 'dsl-md-p' }, h('b', null, '已注册为 DSH 工作区：'), created.project.workspace.title)
              : h('div', { className: 'dsl-muted' }, '（未能注册为 DSH 工作区，不影响使用）'),
            result && result.imported.length > 0
              ? h('div', { className: 'dsl-md-p' }, h('b', null, `导入文件夹文件 ${result.imported.length} 个：`), result.imported.map((item) => item.rel).join('、'))
              : null,
            result && result.added.length > 0
              ? h('div', { className: 'dsl-md-p' }, h('b', null, `上传 ${result.added.length} 个：`), result.added.map((item) => item.title).join('、'))
              : null,
            result && result.fetched.length > 0
              ? h('div', { className: 'dsl-md-p' }, h('b', null, `抓取 ${result.fetched.length} 个：`), result.fetched.map((item) => `${item.title}（${item.chars} 字）`).join('、'))
              : null,
            result && result.failed.length > 0
              ? h('div', { className: 'dsl-md-p' }, h('b', null, `抓取失败 ${result.failed.length} 个：`), result.failed.join('、'))
              : null,
          ),
          h(
            'div',
            { className: 'dsl-card' },
            h('h2', null, '下一步：生成大纲'),
            h('div', { className: 'dsl-muted' }, '面板不能调用模型，这一步交给对话里的 Agent。把下面这句话复制过去即可：'),
            h(CopyHint, { text: handoff }),
          ),
          h(
            'div',
            { className: 'dsl-row' },
            h('button', { className: 'dsl-btn dsl-btn-primary', disabled: busy, onClick: () => onFinish(created ? created.project.id : null) }, '打开项目'),
            h('button', { className: 'dsl-btn', disabled: busy, onClick: onCancel }, '返回项目列表'),
          ),
        )
      }

      return h(
        'div',
        { className: 'dsl-viewer' },
        h(
          'div',
          { className: 'dsl-viewer-head' },
          h('h2', null, '新建学习项目'),
          h(
            'div',
            { className: 'dsl-steps' },
            WIZARD_STEPS.map((label, index) =>
              h('span', { key: label, className: `dsl-pill${index === step ? ' dsl-pill-brand' : ''}` }, `${index + 1}. ${label}`),
            ),
          ),
          h('button', { className: 'dsl-btn', style: { marginLeft: 'auto' }, disabled: busy, onClick: onCancel }, '取消'),
        ),
        h('div', { className: 'dsl-viewer-body', style: { maxWidth: '760px' } }, stepBody()),
      )
    }

    /* ======================================================= 面板外壳 ==== */

    function LearningPanel() {
      const [view, setView] = useState('projects')
      const [projectId, setProjectId] = useState(null)
      const [projects, setProjects] = useState(null)
      const [detail, setDetail] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)
      const [viewer, setViewer] = useState(null)
      const [tab, setTab] = useState('overview')
      const [noteText, setNoteText] = useState('')
      const [wizard, setWizard] = useState(false)

      const loadProjects = useCallback(async () => {
        try {
          setProjects(await fetchProjects())
          setError(null)
        } catch (cause) {
          setError(message(cause))
        }
      }, [])

      const loadDetail = useCallback(async (id) => {
        try {
          setDetail(await fetchProject(id))
          setError(null)
        } catch (cause) {
          setDetail(null)
          setError(message(cause))
        }
      }, [])

      useEffect(() => {
        loadProjects()
      }, [loadProjects])

      const act = useCallback(
        async (payload, next) => {
          setBusy(true)
          try {
            const result = await postAction(payload)
            const targetView = next && next.view ? next.view : view
            const targetId = next && 'projectId' in next ? next.projectId : projectId
            if (targetView === 'project' && targetId) {
              setView('project')
              setProjectId(targetId)
              setDetail(await fetchProject(targetId))
            } else {
              setView('projects')
              setProjects(await fetchProjects())
              setDetail(null)
            }
            setError(null)
            return result
          } catch (cause) {
            setError(message(cause))
            return null
          } finally {
            setBusy(false)
          }
        },
        [view, projectId],
      )

      /** One Host call that leaves the page state alone; the wizard drives this. */
      const call = useCallback(async (payload) => {
        setBusy(true)
        try {
          const result = await postAction(payload)
          setError(null)
          return result
        } catch (cause) {
          setError(message(cause))
          return null
        } finally {
          setBusy(false)
        }
      }, [])

      const open = useCallback((id) => act({ action: 'project_use', projectId: id }, { view: 'project', projectId: id }), [act])

      const finishWizard = useCallback(
        async (id) => {
          setWizard(false)
          if (id) await act({ action: 'project_use', projectId: id }, { view: 'project', projectId: id })
          else await loadProjects()
        },
        [act, loadProjects],
      )

      const back = useCallback(async () => {
        setView('projects')
        setProjectId(null)
        setDetail(null)
        setTab('overview')
        setViewer(null)
        await loadProjects()
      }, [loadProjects])

      const openDoc = useCallback(
        async (title, path) => {
          setViewer({ kind: 'doc', title, path, text: '', loading: true })
          try {
            const response = await fetch(`${API}/file?project=${encodeURIComponent(projectId)}&path=${encodeURIComponent(path)}`)
            const data = await response.json()
            if (!data.ok) throw new Error(data.error || '读取失败')
            setViewer({ kind: 'doc', title, path, text: data.doc.text, loading: false })
          } catch (cause) {
            setViewer({ kind: 'doc', title, path, text: `读取失败：${message(cause)}`, loading: false })
          }
        },
        [projectId],
      )

      const openMaterial = useCallback(
        async (material) => {
          setViewer({
            kind: 'material',
            title: material.title,
            path: material.file,
            material,
            text: '',
            reading: material.reading,
            notes: material.notes || [],
            loading: true,
          })
          setBusy(true)
          try {
            const result = await postAction({ action: 'material_read', projectId, id: material.id })
            setViewer({
              kind: 'material',
              title: result.title,
              path: result.file,
              material,
              text: result.text,
              reading: result.reading,
              notes: result.notes || [],
              loading: false,
            })
          } catch (cause) {
            setViewer({
              kind: 'material',
              title: material.title,
              path: material.file,
              material,
              text: `读取失败：${message(cause)}`,
              reading: material.reading,
              notes: material.notes || [],
              loading: false,
            })
          } finally {
            setBusy(false)
          }
        },
        [projectId],
      )

      const refreshViewer = useCallback(
        async (material) => {
          try {
            const result = await postAction({ action: 'material_read', projectId, id: material.id })
            setViewer((current) =>
              current && current.kind === 'material' ? { ...current, reading: result.reading, notes: result.notes || [] } : current,
            )
            setDetail(await fetchProject(projectId))
          } catch (cause) {
            setError(message(cause))
          }
        },
        [projectId],
      )

      const onMarkRead = useCallback(
        async (current) => {
          await postAction({
            action: 'reading_progress',
            projectId,
            materialId: current.material.id,
            locator: Math.max(Number(current.material.chars) || 1, 1),
            percent: 1,
            minutes: 1,
          })
          await refreshViewer(current.material)
        },
        [projectId, refreshViewer],
      )

      const styleTag = h('style', { key: 'dsl-style' }, CSS)

      if (view === 'projects' && projects === null) {
        return h(
          'div',
          { className: 'dsl-root dsl-center' },
          styleTag,
          error ? h('div', { className: 'dsl-error' }, error) : '正在读取学习项目…',
        )
      }

      const header =
        view === 'projects'
          ? h(
              'header',
              { className: 'dsl-head' },
              h(
                'div',
                { className: 'dsl-head-title' },
                h('h1', null, 'DashinLearning'),
                h('span', { className: 'dsl-head-sub' }, `共 ${projects.count} 个 · ${projects.root}`),
              ),
              h(
                'div',
                { className: 'dsl-head-actions' },
                busy ? h('span', { className: 'dsl-busy' }, '处理中…') : null,
                h('button', { className: 'dsl-btn', disabled: busy, onClick: loadProjects }, '刷新'),
              ),
            )
          : h(
              'header',
              { className: 'dsl-head' },
              h(
                'div',
                { className: 'dsl-head-title' },
                h('button', { className: 'dsl-btn', onClick: back }, '← 所有项目'),
                h('h1', null, detail ? detail.project.title : '加载中…'),
              ),
              detail
                ? h(
                    'div',
                    { className: 'dsl-pills' },
                    h(Pill, null, `${detail.stats.chapters} 章`),
                    h(Pill, { tone: 'success' }, `已掌握 ${detail.stats.knowledgePointsMastered}/${detail.stats.knowledgePoints}`),
                    h(Pill, { tone: detail.stats.chaptersBlocked ? 'warn' : 'neutral' }, `被拦 ${detail.stats.chaptersBlocked}`),
                    h(Pill, { tone: detail.stats.reviewsDue ? 'error' : 'neutral' }, `待复习 ${detail.stats.reviewsDue}`),
                    h(Pill, { tone: detail.stats.errorsActive ? 'warn' : 'neutral' }, `错题 ${detail.stats.errorsActive}`),
                  )
                : null,
              h(
                'div',
                { className: 'dsl-head-actions' },
                busy ? h('span', { className: 'dsl-busy' }, '处理中…') : null,
                h('button', { className: 'dsl-btn', disabled: busy, onClick: () => projectId && loadDetail(projectId) }, '刷新'),
              ),
            )

      return h(
        'div',
        { className: 'dsl-root' },
        styleTag,
        header,
        error ? h('div', { className: 'dsl-error' }, error) : null,
        view === 'project'
          ? h(
              'nav',
              { className: 'dsl-tabs' },
              TABS.map(([id, label]) =>
                h(
                  'button',
                  {
                    key: id,
                    className: `dsl-tab${tab === id ? ' dsl-tab-active' : ''}`,
                    onClick: () => {
                      setTab(id)
                      setViewer(null)
                    },
                  },
                  label,
                ),
              ),
            )
          : null,
        view === 'projects'
          ? h(ProjectsPage, { state: projects, busy, onOpen: open, onAction: act, onCreate: () => setWizard(true) })
          : detail === null
            ? h('div', { className: 'dsl-body dsl-muted' }, '正在读取项目…')
            : h(ProjectDetail, { state: detail, busy, onAction: act, openDoc, openMaterial, tab, setTab }),

        view === 'projects'
          ? h(
              'div',
              { className: 'dsl-foot' },
              `Host 壳 ${when(projects.host && projects.host.shellLoadedAt)} · impl #${projects.host ? projects.host.implRevision : '?'} · mtime ${projects.host ? projects.host.implMtimeMs : '?'}`,
            )
          : null,

        wizard
          ? h(ProjectWizard, {
              busy,
              call,
              onFinish: finishWizard,
              onCancel: () => setWizard(false),
            })
          : null,

        viewer
          ? h(
              'div',
              { className: 'dsl-viewer' },
              h(
                'div',
                { className: 'dsl-viewer-head' },
                h('button', { className: 'dsl-btn', onClick: () => setViewer(null) }, '← 返回'),
                h('h2', null, viewer.title),
                h('span', { className: 'dsl-muted' }, viewer.path),
                viewer.kind === 'material'
                  ? h(
                      'span',
                      { className: 'dsl-row dsl-row-grow', style: { marginLeft: 'auto' } },
                      h(Bar, { value: ((viewer.reading && viewer.reading.furthestPercent) || 0) * 100 }),
                      h('span', { className: 'dsl-muted' }, `读到 ${pct((viewer.reading && viewer.reading.furthestPercent) || 0)}`),
                      h('button', { className: 'dsl-btn', disabled: busy, onClick: () => onMarkRead(viewer) }, '标记已读完'),
                    )
                  : null,
              ),
              h('div', { className: 'dsl-viewer-body' }, viewer.loading ? '读取中…' : markdown(viewer.text)),
              viewer.kind === 'material' && !viewer.loading
                ? h(
                    'div',
                    { className: 'dsl-viewer-side' },
                    h('h3', { style: { margin: '0 0 8px' } }, `笔记（${(viewer.notes || []).length}）`),
                    h(
                      'div',
                      { className: 'dsl-row', style: { marginBottom: '8px' } },
                      h('input', {
                        className: 'dsl-input dsl-row-grow',
                        placeholder: '记一条笔记（会带上当前进度位置）',
                        value: noteText,
                        onChange: (event) => setNoteText(event.target.value),
                        onKeyDown: async (event) => {
                          if (event.key !== 'Enter' || !noteText.trim()) return
                          const text = noteText
                          setNoteText('')
                          await act({
                            action: 'note_add',
                            projectId,
                            materialId: viewer.material.id,
                            text,
                            locator: (viewer.reading && viewer.reading.furthestLocator) || 1,
                            percent: (viewer.reading && viewer.reading.furthestPercent) || 0,
                          })
                          await refreshViewer(viewer.material)
                        },
                      }),
                      h(
                        'button',
                        {
                          className: 'dsl-btn',
                          disabled: busy || !noteText.trim(),
                          onClick: async () => {
                            const text = noteText
                            setNoteText('')
                            await act({
                              action: 'note_add',
                              projectId,
                              materialId: viewer.material.id,
                              text,
                              locator: (viewer.reading && viewer.reading.furthestLocator) || 1,
                              percent: (viewer.reading && viewer.reading.furthestPercent) || 0,
                            })
                            await refreshViewer(viewer.material)
                          },
                        },
                        '加笔记',
                      ),
                    ),
                    (viewer.notes || []).length === 0
                      ? h('div', { className: 'dsl-muted' }, '还没有笔记。')
                      : h(
                          'div',
                          { className: 'dsl-list' },
                          (viewer.notes || []).map((note) =>
                            h(
                              'div',
                              { key: note.id, className: 'dsl-note' },
                              h(
                                'div',
                                { className: 'dsl-note-anchor' },
                                note.anchor ? h('div', { className: 'dsl-note-meta' }, `「${note.anchor}」`) : null,
                                h('div', null, note.text),
                                h('div', { className: 'dsl-note-meta' }, `第 ${note.locator} 段 · ${when(note.createdAt)}`),
                              ),
                              h(
                                'button',
                                {
                                  className: 'dsl-btn dsl-btn-tiny dsl-btn-danger',
                                  disabled: busy,
                                  onClick: async () => {
                                    await act({ action: 'note_remove', projectId, materialId: viewer.material.id, id: note.id })
                                    await refreshViewer(viewer.material)
                                  },
                                },
                                '删除',
                              ),
                            ),
                          ),
                        ),
                  )
                : null,
            )
          : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        uiWorkspace = (typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : undefined) ?? null
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 1, label: 'DashinLearning' }, PanelIcon),
        )
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, LearningPanel))
      },
    }
  },
})
