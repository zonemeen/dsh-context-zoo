"use client";

import { useEffect, useState } from "react";
import { Activity, BookOpen, Check, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, Code2, Database, FileText, GitBranch, Github, Globe2, Layers3, Pause, Play, RotateCcw, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { budgetFor, REPO, strategies, type Locale, type Strategy, type StrategyId } from "@/lib/strategies";
import { dictionaries, formatTokens, localizedSource, number } from "@/lib/i18n";
import { simulate, type BlockKind, type ScenarioId } from "@/lib/simulation";

import { Cases } from "./cases";

type View = "lab" | "compare" | "cases";
const scenarioIds: ScenarioId[] = ["coding", "tools", "requirements"];
const blockLabels: Record<BlockKind, "protected" | "conversation" | "tools" | "recent" | "summary" | "restored"> = { system: "protected", dialogue: "conversation", tool: "tools", recent: "recent", summary: "summary", restored: "restored" };

export function Atlas() {
  const [locale, setLocale] = useState<Locale>("zh");
  const [view, setView] = useState<View>("lab");
  const [selected, setSelected] = useState<StrategyId>("deepseek");
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [windowSize, setWindowSize] = useState(131072);
  const [scenario, setScenario] = useState<ScenarioId>("coding");
  const [reducedMotion, setReducedMotion] = useState(false);
  const t = dictionaries[locale];
  const strategy = strategies.find(item => item.id === selected)!;

  useEffect(() => {
    try {
      const saved = localStorage.getItem("context-atlas-locale");
      if (saved === "zh" || saved === "en") setLocale(saved);
    } catch { /* Language switching remains available when storage is unavailable. */ }
    const query = matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(query.matches);
    setPlaying(!query.matches);
    const update = () => { setReducedMotion(query.matches); if (query.matches) setPlaying(false); };
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
    document.title = locale === "zh" ? "Context Atlas — 上下文策略图谱" : "Context Atlas — Context management, explored";
  }, [locale]);

  useEffect(() => {
    if (!playing || view !== "lab") return;
    const timer = setTimeout(() => {
      if (step === 4) setPlaying(false);
      else setStep(current => current + 1);
    }, 3200 / speed);
    return () => clearTimeout(timer);
  }, [playing, step, speed, view]);

  function toggleLocale() {
    const next = locale === "zh" ? "en" : "zh";
    setLocale(next);
    try { localStorage.setItem("context-atlas-locale", next); } catch { /* A session-only preference is sufficient without storage. */ }
  }
  function selectStrategy(id: StrategyId) {
    setSelected(id); setStep(0); setPlaying(!reducedMotion); setView("lab");
  }
  function selectStep(next: number) { setStep(next); setPlaying(false); }
  function togglePlayback() {
    if (step === 4 && !playing) setStep(0);
    setPlaying(current => !current);
  }

  return (
    <div className="atlas-app">
      <a className="skip-link" href="#main-content">{t.skip}</a>
      <header className="site-header">
        <a className="brand" href="/" aria-label="Context Atlas"><span className="brand-symbol"><span /><span /><span /></span><span>context<span className="brand-weight">atlas</span><span className="brand-period">.</span></span></a>
        <div className="header-divider" />
        <nav className="main-nav" aria-label={t.title}>
          {(["lab", "compare", "cases"] as View[]).map(id => <button key={id} className={view === id ? "nav-active" : ""} aria-current={view === id ? "page" : undefined} onClick={() => setView(id)}>{t[id]}{id === "lab" && <span className="nav-count">09</span>}</button>)}
        </nav>
        <div className="header-actions"><button className="language-button" onClick={toggleLocale} aria-label={t.language}><Globe2 size={16} /><span>{locale === "zh" ? "EN" : "中文"}</span></button><a href={REPO} target="_blank" rel="noreferrer" className="github-link" aria-label={t.github}><Github size={19} /></a></div>
      </header>
      <div className="app-body">
        <aside className="sidebar" aria-label={t.collection}>
          <div className="sidebar-heading"><span>{t.collection}</span><span>09</span></div>
          <div className="strategy-list">
            {strategies.map((item, index) => <div className="strategy-item-wrap" key={item.id}>{index === 1 && <div className="adapter-label">{t.adapters}</div>}<button className={`strategy-button ${selected === item.id && view === "lab" ? "selected" : ""}`} aria-pressed={selected === item.id && view === "lab"} onClick={() => selectStrategy(item.id)}><span className="strategy-mark" style={{ color: item.color }}>{item.mark}</span><span className="strategy-button-copy"><strong>{item.name}</strong><small>{item[locale].subtitle}</small></span>{item.id === "deepseek" ? <span className="native-tag">{t.native}</span> : <span className="strategy-number">{String(index + 1).padStart(2, "0")}</span>}</button></div>)}
          </div>
          <div className="sidebar-bottom"><span className="mini-orbit"><GitBranch size={21} /></span><p>{t.sidebarNote}</p><span>{t.sidebarDetail}</span><div className="sidebar-edition">{t.edition}<span>↗</span></div></div>
        </aside>
        <main id="main-content" className="main-content">
          <div className="content-inner">
            {view === "lab" && <>
              <div className="page-intro"><div><p className="eyebrow"><span />{t.eyebrow}</p><h1>{t.heading}</h1><p className="intro-description">{t.intro}</p></div><div className="edition-label"><Layers3 size={19} /><span>THE CONTEXT<br />COLLECTION <b>001—009</b></span></div></div>
              <section className="lab" aria-label={t.lab}>
                <div className="lab-topline"><div className="strategy-title"><span className="large-mark" style={{ color: strategy.color }}>{strategy.mark}</span><div><div className="name-line"><h2>{strategy.name}</h2><span className="pill">{selected === "deepseek" ? t.native : "DSH ADAPTER"}</span></div><p>{strategy[locale].subtitle}</p></div></div><a className="text-link" href={localizedSource(strategy.source, locale)} target="_blank" rel="noreferrer"><BookOpen size={15} />{t.viewSource}</a></div>
                <div className="lab-controls"><div className="control-field"><label htmlFor="scenario"><SlidersHorizontal size={14} />{t.scenario}</label><div className="select-wrap"><select id="scenario" value={scenario} onChange={e => { setScenario(e.target.value as ScenarioId); setStep(0); setPlaying(false); }}>{scenarioIds.map((id, i) => <option key={id} value={id}>{t.scenarios[i]}</option>)}</select><ChevronDown size={13} /></div></div><div className="control-field"><label htmlFor="window">{t.window}</label><div className="select-wrap"><select id="window" value={windowSize} onChange={e => { setWindowSize(Number(e.target.value)); setStep(0); setPlaying(false); }}>{[131072, 262144, 524288].map(value => <option key={value} value={value}>{value / 1024}K tokens</option>)}</select><ChevronDown size={13} /></div></div><span className="simulation-label"><span className="hollow-dot" />{t.simulation}</span></div>
                <div className="lab-grid"><div className="visual-panel"><ContextFlow strategy={strategy} locale={locale} step={step} playing={playing} windowSize={windowSize} scenario={scenario} /><div className="playback"><button className="play-button" onClick={togglePlayback}>{playing ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}<span>{playing ? t.pause : step === 4 ? t.replay : t.play}</span></button><div className="playback-progress">{strategy[locale].steps.map((label, i) => <button key={i} aria-label={`${t.stage} ${i + 1}: ${label}`} aria-pressed={step === i} className={`progress-segment ${i <= step ? "filled" : ""}`} onClick={() => selectStep(i)} />)}</div><span className="step-counter">0{step + 1}<span> / 05</span></span><div className="playback-buttons"><button className="icon-button" onClick={() => selectStep(Math.max(0, step - 1))} disabled={step === 0} aria-label={t.previous}><ChevronLeft size={17} /></button><button className="icon-button" onClick={() => selectStep(Math.min(4, step + 1))} disabled={step === 4} aria-label={t.next}><ChevronRight size={17} /></button><button className="speed-button" aria-label={t.speed} onClick={() => setSpeed(current => current === 2 ? .5 : current === .5 ? 1 : 2)}>{speed}×</button><button className="icon-button reset-button" aria-label={t.reset} onClick={() => selectStep(0)}><RotateCcw size={14} /></button></div></div><p className="trace-caption"><CircleHelp size={13} />{t.traceCaption}</p></div><div className="pipeline-panel"><div className="panel-label"><span>{t.behavior}</span><span>01—05</span></div><div className="steps-list">{strategy[locale].steps.map((label, i) => <button className={`pipeline-step ${step === i ? "active" : ""} ${step > i ? "complete" : ""}`} key={i} aria-pressed={step === i} onClick={() => selectStep(i)}><span className="step-dot">{step > i ? <Check size={12} /> : String(i + 1).padStart(2, "0")}</span><span><strong>{label}</strong>{step === i && <span className="step-detail">{strategy[locale].details[i]}</span>}</span></button>)}</div><p className="mobile-step-detail">{strategy[locale].details[step]}</p><div className="pipeline-foot"><ShieldCheck size={14} /><span>{t.guard}</span><span className="tiny-divider" /><span>{t.pairs}</span></div></div></div>
              </section>
              <div className="insights-grid"><BudgetCard strategy={strategy} locale={locale} windowSize={windowSize} /><article className="principle-card"><p className="eyebrow muted"><GitBranch size={14} />{t.principle}</p><h3>{strategy[locale].description}</h3><p>{strategy[locale].principle}</p><div className="principle-detail"><span>{t.recovery}</span><strong>{strategy[locale].recovery}</strong></div></article></div>
              <div className="source-note"><Code2 size={16} /><div><span>{t.sourceNote} <code>{strategy.revision}</code></span><p>{strategy[locale].caveat}</p></div></div>
            </>}
            {view === "compare" && <Comparison locale={locale} onSelect={selectStrategy} />}
            {view === "cases" && <Cases locale={locale} onExplore={selectStrategy} />}
            <footer className="site-footer"><span>{t.project}</span><span>{t.footer}<span className="footer-dot">·</span>{t.sourceDate}</span></footer>
          </div>
        </main>
      </div>
    </div>
  );
}

function ContextFlow({ strategy, locale, step, playing, windowSize, scenario }: { strategy: Strategy; locale: Locale; step: number; playing: boolean; windowSize: number; scenario: ScenarioId }) {
  const t = dictionaries[locale];
  const trace = simulate(strategy.id, windowSize, scenario);
  const done = step >= 3;
  const projected = done ? trace.afterTokens : step >= 1 ? trace.beforeTokens - trace.prunedTokens : trace.beforeTokens;
  return <div className={`context-flow ${playing ? "is-playing" : ""}`} data-step={step}>
    <div className="flow-header"><h3><Activity size={15} />{t.contextFlow}</h3><span>{t.mechanism}</span></div>
    <div className="flow-legend">{(["system", "dialogue", "tool", "recent"] as BlockKind[]).map(kind => <span key={kind}><i className={`legend-dot ${kind}`} />{t[blockLabels[kind]]}</span>)}</div>
    <div className="flow-columns-label"><span>{t.before}<code>{formatTokens(trace.beforeTokens)}</code></span><span>{t.after}<code>{done ? formatTokens(trace.afterTokens) : "—"}</code></span></div>
    <div className="history-map">
      <div className="message-stack before-stack">{trace.before.map((block, i) => <div key={block.id} className={`message-block ${block.kind} ${step >= 1 && block.kind === "tool" && trace.hasPruning ? "is-pruned" : ""} ${step >= 2 && block.kind !== "system" && !(block.kind === "recent" && trace.hasTail) ? "is-selected" : ""}`} style={{ "--stagger": `${i * 50}ms` } as React.CSSProperties}><span className="block-index">0{i + 1}</span><span className="block-lines"><i /><i /></span><span className="block-role">{block.kind === "system" ? "system" : block.kind === "tool" ? "tool_result" : block.kind === "recent" ? "recent" : i === 1 ? "user" : "assistant"}</span>{block.kind === "system" ? <ShieldCheck size={12} /> : block.kind === "recent" && trace.hasTail ? <span className="preserve-dot" /> : <span className="block-token">{formatTokens(block.tokens)}</span>}</div>)}</div>
      <div className={`flow-connections ${done ? "connections-done" : ""}`} aria-hidden="true"><svg viewBox="0 0 300 308" preserveAspectRatio="none"><path className="connector preserved-path" d="M0 19 C135 19 165 19 300 19" />{[61, 103, 145, 187, 229].map((y, i) => <path key={y} className={`connector merging-path path-${i}`} d={`M0 ${y} C115 ${y} 165 105 300 105`} />)}<path className="connector tail-path" d={`M0 271 C140 271 170 ${trace.hasTail ? 192 : 175} 300 ${trace.hasTail ? 192 : 175}`} /></svg><div className={`flow-operation ${done ? "done" : ""}`}><span>{done ? <Layers3 size={20} /> : step === 0 ? <Activity size={20} /> : <SlidersHorizontal size={20} />}</span><strong>{strategy[locale].steps[step]}</strong><small>{step === 4 ? t.committed : step === 3 ? t.condensed : step === 1 && trace.hasPruning ? t.pruned : t.processing}</small></div></div>
      <div className="message-stack after-stack"><div className="message-block system"><ShieldCheck size={12} /><span>{t.protected}</span><span className="block-token">{formatTokens(trace.after[0].tokens)}</span></div><div aria-hidden={!done} className={`checkpoint-block ${done ? "visible" : ""}`}><span className="checkpoint-label"><Layers3 size={14} />{t.summary}</span><span className="summary-lines"><i /><i /><i /></span><span className="checkpoint-code">{strategy.id === "pi" ? "history + turn prefix" : strategy.id === "qwen-code" ? "<state_snapshot>" : "<checkpoint>"}</span></div><div aria-hidden={!done} className={`retained-block ${done ? "visible" : ""} ${trace.restored ? "restored" : "recent"}`}><span>{trace.hasTail ? <FileText size={14} /> : <RotateCcw size={14} />}{trace.hasTail ? t.recent : t.restored}</span><small>{trace.hasTail ? t.retained : strategy[locale].recovery}</small></div><div aria-hidden={!done} className={`free-space ${done ? "visible" : ""}`}><span>{t.free}</span><strong>{formatTokens(windowSize - trace.afterTokens)}<small> tokens</small></strong></div>{!done && <div className="waiting-checkpoint"><span className="waiting-lines"><i /><i /><i /></span><span>{t.waiting}</span></div>}</div>
    </div>
    <div className="durable-log"><Database size={13} /><span>{t.original}</span><div className="log-ticks">{Array.from({ length: 32 }, (_, i) => <i key={i} />)}</div><small>{t.originalHint}</small><Check size={13} /></div>
    <div className="flow-stats"><div><span>{t.tokensBefore}</span><strong>{formatTokens(trace.beforeTokens)}<small> tokens</small></strong></div><div><span>{t.tokensAfter}</span><strong className={step === 4 ? "green-text" : ""}>{formatTokens(projected)}<small> tokens</small></strong></div><div><span>{t.reduction}</span><strong className={step === 4 ? "green-text" : ""}>{((1 - projected / trace.beforeTokens) * 100).toFixed(1)}<small>%</small></strong></div></div>
  </div>;
}

function BudgetCard({ strategy, locale, windowSize }: { strategy: Strategy; locale: Locale; windowSize: number }) {
  const t = dictionaries[locale];
  const budget = budgetFor(strategy.id, windowSize);
  const percent = budget.trigger / windowSize * 100;
  return <article className="budget-card"><div className="budget-top"><p className="eyebrow muted"><SlidersHorizontal size={14} />{t.trigger}</p><span>{windowSize / 1024}K WINDOW</span></div><div className="budget-value"><strong>{number(budget.trigger)}</strong><span>tokens</span><code>{percent.toFixed(1)}%</code></div><div className="budget-meter"><div style={{ width: `${percent}%` }} /><i style={{ left: `${percent}%` }} /></div><div className="meter-labels"><span>0</span><code>{strategy.trigger}</code><span>{windowSize / 1024}K</span></div><div className="retention-line"><span>{t.retention}</span><strong>{strategy[locale].retention}</strong></div><p className="budget-footnote">{t.formulaNote}</p></article>;
}

function Comparison({ locale, onSelect }: { locale: Locale; onSelect: (id: StrategyId) => void }) {
  const t = dictionaries[locale];
  return <><div className="page-intro"><div><p className="eyebrow"><span />{t.compareEyebrow}</p><h1>{t.compareHeading}</h1><p className="intro-description">{t.compareIntro}</p></div></div><div className="comparison-table-wrap"><table className="comparison-table"><thead><tr><th>{t.strategy}</th><th>{t.trigger}</th><th>{t.retention}</th><th>{t.pruning}</th><th>{t.recovery}</th></tr></thead><tbody>{strategies.map(s => <tr key={s.id}><th><button onClick={() => onSelect(s.id)}><span className="strategy-mark" style={{ color: s.color }}>{s.mark}</span><span>{s.name}<small>{s.revision}</small></span></button></th><td><code>{s.trigger}</code></td><td>{s[locale].retention}</td><td><span className={`prune-badge ${s.pruning}`}>{s.pruning === "default" ? t.defaultOn : s.pruning === "optional" ? t.optional : t.noPrune}</span></td><td>{s[locale].recovery}</td></tr>)}</tbody></table></div><div className="source-note"><CircleHelp size={17} /><p>{t.compareNote}</p></div></>;
}
