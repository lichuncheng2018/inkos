/**
 * The writer turns each memo beat into roughly one paragraph, so a memo whose
 * beats are long, procedure-laden sentences comes back as a report. This check
 * finds that shape so the planner can be asked once to plan the scenes around
 * people instead.
 */
export interface MemoDensityReport {
  readonly beats: number;
  readonly averageBeatLength: number;
  readonly longBeats: ReadonlyArray<string>;
  readonly paperwork: ReadonlyArray<readonly [term: string, count: number]>;
  readonly longNotes: number;
  readonly dense: boolean;
}

const ZH_PAPERWORK = /核验|核查|核实|核准|审批|批复|备案|报备|受理|凭证|票据|回执|签收|签字|盖章|公章|手续|流程|原件|复印件|登记|对账|台账|审计|合规|条款|表决|决议|章程|申报|账目|账户/g;
const EN_PAPERWORK = /\b(?:verif\w*|approv\w*|filings?|receipts?|signatures?|stamp(?:ed|s)?|paperwork|procedur\w*|audit\w*|complian\w*|clauses?|ledgers?|invoices?|registr\w*|votes?|voted|resolutions?|bylaws|documentation|reconcil\w*)\b/gi;

const LIMITS = {
  zh: { longBeat: 80, averageBeat: 72, longNote: 120 },
  en: { longBeat: 45, averageBeat: 40, longNote: 60 },
} as const;
const LONG_BEATS_ALLOWED = 2;
const PAPERWORK_ALLOWED = 7;
const NOTES_ALLOWED = 5;

export function assessMemoDensity(body: string, language: "zh" | "en"): MemoDensityReport {
  const limits = LIMITS[language];
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const notesStart = lines.findIndex((line) => /^##\s*(?:备注|Notes)\s*$/i.test(line.trim()));
  const scenesStart = lines.findIndex((line) => /^##\s*(?:场次|Scenes)\s*$/i.test(line.trim()));
  const sceneLines = lines.slice(scenesStart >= 0 ? scenesStart + 1 : 0, notesStart >= 0 ? notesStart : undefined);
  const noteLines = notesStart >= 0 ? lines.slice(notesStart + 1) : [];
  const bullets = (section: ReadonlyArray<string>) =>
    section.map((line) => line.trim()).filter((line) => /^[-*]\s+/.test(line)).map((line) => line.replace(/^[-*]\s+/, ""));

  const beats = bullets(sceneLines);
  const notes = bullets(noteLines);
  const measure = (text: string) => language === "en"
    ? text.split(/\s+/).filter(Boolean).length
    : text.replace(/\s/g, "").length;
  const lengths = beats.map(measure);
  const averageBeatLength = lengths.length > 0 ? lengths.reduce((sum, value) => sum + value, 0) / lengths.length : 0;
  const longBeats = beats.filter((_, index) => lengths[index]! > limits.longBeat);

  const counts = new Map<string, number>();
  for (const match of sceneLines.join("\n").matchAll(language === "en" ? EN_PAPERWORK : ZH_PAPERWORK)) {
    const term = match[0].toLowerCase();
    counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  const paperwork = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const paperworkTotal = paperwork.reduce((sum, [, count]) => sum + count, 0);
  const longNotes = notes.filter((note) => measure(note) > limits.longNote).length;

  const dense = longBeats.length > LONG_BEATS_ALLOWED
    || averageBeatLength > limits.averageBeat
    || paperworkTotal > PAPERWORK_ALLOWED
    || longNotes > 0
    || notes.length > NOTES_ALLOWED;
  return { beats: beats.length, averageBeatLength, longBeats, paperwork, longNotes, dense };
}

/** What the planner is told when its memo comes back too dense; it resubmits once. */
export function memoDensityFeedback(report: MemoDensityReport, language: "zh" | "en"): string {
  const limits = LIMITS[language];
  const paperworkTotal = report.paperwork.reduce((sum, [, count]) => sum + count, 0);
  const excerpt = (beat: string) => (language === "en" ? beat.split(/\s+/).slice(0, 12).join(" ") : beat.slice(0, 24)) + "…";
  if (language === "en") {
    return [
      "This memo is too dense: written beat by beat it would read as a report. Keep the goal, the scenes, the people, the figures that matter and how the chapter ends, and submit the memo again with these changes:",
      report.longBeats.length > LONG_BEATS_ALLOWED || report.averageBeatLength > limits.averageBeat
        ? `- Each beat is one short sentence: who does or says what to whom, and how the other takes it. Split or cut the beats that pack several steps, such as: ${report.longBeats.slice(0, 4).map(excerpt).join(" / ")}`
        : "",
      paperworkTotal > PAPERWORK_ALLOWED
        ? `- Procedure fills the scenes (${report.paperwork.slice(0, 6).map(([term, count]) => `${term} ×${count}`).join(", ")}). In each scene keep only the step that changes the situation, as an outcome, and drop the rest or fold it into a pass-over line. Give the beats to the people: what each wants, how they push, who gives way, who pays for it.`
        : "",
      report.longNotes > 0 || report.beats === 0
        ? "- Notes are one sentence each: only the figures the writer must check, the facts that must match, and what must not happen."
        : "",
    ].filter(Boolean).join("\n");
  }
  return [
    "这份章纲太密，写手一条一段写出来会像公文。目标、场次、人物、要紧的数字和结局都不变，按下面改完重新提交：",
    report.longBeats.length > LONG_BEATS_ALLOWED || report.averageBeatLength > limits.averageBeat
      ? `- 每条节拍一句短话：谁对谁做了什么、说了什么，对方怎么接。一条里塞了几步的拆开，次要的删掉，比如：${report.longBeats.slice(0, 4).map(excerpt).join("／")}`
      : "",
    paperworkTotal > PAPERWORK_ALLOWED
      ? `- 手续和文书占满了场次（${report.paperwork.slice(0, 6).map(([term, count]) => `${term}×${count}`).join("、")}）。每场戏只留改变局面的那一步，写成结果，其余删掉或并进带过的一句。节拍留给人：谁想要什么，怎么争，谁让了步，谁吃了亏。`
      : "",
    report.longNotes > 0 || report.beats === 0
      ? "- 备注每条一句，只留写手要核对的数字、必须和前文对上的事实、这一章不能发生的事。"
      : "",
  ].filter(Boolean).join("\n");
}
