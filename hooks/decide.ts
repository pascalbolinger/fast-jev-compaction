import type { JevAnswer, JevQuestions } from '../src/types.js';

/**
 * The `jev_decide` tool: one yes/no or one multiple-choice question put to
 * Jev, with the facts it needs. Jev sees only what the call carries, not the
 * conversation, and answers with probabilities, not with reasons.
 */
export const DECIDE_TOOL = 'jev_decide';

const MAX_QUESTION_CHARS = 2_000;
const MAX_CONTEXT_CHARS = 20_000;
const MAX_OPTIONS = 8;
const MAX_OPTION_CHARS = 500;

export const DECIDE_DESCRIPTION =
  'Ask Jev (TypeSafe System One, a fast external decision model) one yes/no or multiple-choice question and get probabilities back. ' +
  'Use it as a second opinion on a judgement call with clear options: which of several approaches fits, whether something is done, relevant, risky or worth doing. ' +
  'Jev sees ONLY the question, the options and the context you pass, never the conversation, so put every fact it needs into `context`. ' +
  'It gives no reasons: report the answer with its probability, treat a probability near 0.5 (or a low confidence) as "Jev cannot tell", and decide yourself. ' +
  'The question, options and context are sent to TypeSafe: never include passwords, keys, customer, patient or other personal data. ' +
  'Not for facts, maths, code or anything that needs reasoning.';

export const DECIDE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    question: { type: 'string', description: 'The question, self-contained. For a yes/no question, phrase it so that "yes" is unambiguous.' },
    options: {
      type: 'array',
      minItems: 2,
      maxItems: MAX_OPTIONS,
      description: 'For a multiple-choice question: the options. Leave out for a yes/no question.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short label, unique among the options.' },
          description: { type: 'string', description: 'What choosing this option means.' },
        },
        required: ['name'],
      },
    },
    context: { type: 'string', description: 'The facts Jev needs to answer: the situation, the goal, the constraints. No secrets, no personal data.' },
  },
  required: ['question'],
};

export type DecideOption = { name: string; description?: string };

export type DecideRequest = {
  kind: 'yesno' | 'choice';
  state: { question: string; context: string };
  questions: JevQuestions;
  options: DecideOption[];
};

/**
 * The key an option travels under: `A`, `B`, ... Its name goes in the value
 * beside it, because a request's values are redacted and its keys are not.
 */
export function optionId(index: number): string {
  return String.fromCharCode(65 + index);
}

function text(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

/** The Jev request for a tool call's input; throws with what is wrong with it. */
export function decideRequest(input: Readonly<Record<string, unknown>>): DecideRequest {
  const question = text(input['question'], MAX_QUESTION_CHARS);
  if (!question) throw new Error('`question` is required');
  const state = { question, context: text(input['context'], MAX_CONTEXT_CHARS) };
  const raw = input['options'];
  if (raw === undefined || raw === null || (Array.isArray(raw) && raw.length === 0)) {
    return {
      kind: 'yesno',
      state,
      options: [],
      questions: {
        decision: {
          type: 'noul',
          instructions: question,
          criteria: { true: 'The answer to the question is yes.', false: 'The answer to the question is no.' },
        },
      },
    };
  }
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > MAX_OPTIONS) {
    throw new Error(`\`options\` takes 2 to ${MAX_OPTIONS} entries; leave it out for a yes/no question`);
  }
  const options: DecideOption[] = [];
  for (const entry of raw) {
    const record = typeof entry === 'string' ? { name: entry } : (entry as Record<string, unknown> | null);
    const name = text(record?.['name'], 80);
    if (!name) throw new Error('every option needs a `name`');
    if (options.some((option) => option.name === name)) throw new Error(`option "${name}" is given twice`);
    const description = text(record?.['description'], MAX_OPTION_CHARS);
    options.push(description ? { name, description } : { name });
  }
  return {
    kind: 'choice',
    state,
    options,
    questions: {
      decision: {
        type: 'choice',
        instructions: question,
        criteria: Object.fromEntries(
          options.map((option, index) => [
            optionId(index),
            option.description ? `${option.name}: ${option.description}` : option.name,
          ]),
        ),
      },
    },
  };
}

function share(probability: number): string {
  return `${Math.round(Math.min(1, Math.max(0, probability)) * 100)}%`;
}

/** A yes/no answer leaning less than this far either way, or a choice less confident, says nothing. */
const UNSURE_BELOW_PERCENT = 65;

function percent(probability: number): number {
  return Math.round(Math.min(1, Math.max(0, probability)) * 100);
}

export type Decision = {
  /** What the model reads as the tool's result. */
  text: string;
  /** One line for the transcript. */
  line: string;
};

/** Jev's answer as the tool's result; throws when it is not the kind that was asked for. */
export function describeDecision(request: DecideRequest, answer: JevAnswer | undefined): Decision {
  if (request.kind === 'yesno') {
    if (!answer || !('noul' in answer) || !Number.isFinite(answer.noul)) throw new Error('Jev gave no yes/no answer');
    if (answer.noul < 0 || answer.noul > 1) throw new Error('Jev gave a probability outside 0 to 1');
    const yes = answer.noul;
    // Judged on the percentage shown, so the verdict never contradicts it.
    const leaning = Math.max(percent(yes), 100 - percent(yes));
    const verdict = leaning < UNSURE_BELOW_PERCENT ? 'cannot tell' : yes >= 0.5 ? 'yes' : 'no';
    return {
      text:
        `Jev: ${verdict} (probability of yes: ${share(yes)}).` +
        (verdict === 'cannot tell' ? ' This is close to a coin flip: do not lean on it.' : '') +
        ' Jev gives no reasons and saw only the question and context of this call.',
      line: `Jev decided: ${verdict} (yes ${share(yes)})`,
    };
  }
  if (!answer || !('choice' in answer) || typeof answer.choice !== 'string') throw new Error('Jev gave no choice');
  const names = new Map(request.options.map((option, index) => [optionId(index), option.name]));
  const chosen = names.get(answer.choice);
  if (chosen === undefined) throw new Error('Jev chose an option that was not offered');
  if (!Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1) {
    throw new Error('Jev gave a confidence outside 0 to 1');
  }
  const ranked = Object.entries(answer.probabilities)
    .filter(([id, probability]) => names.has(id) && Number.isFinite(probability))
    .sort((a, b) => b[1] - a[1]);
  const top = ranked[0];
  const outranked = top !== undefined && top[0] !== answer.choice && top[1] > (answer.probabilities[answer.choice] ?? 0);
  const unsure = percent(answer.confidence) < UNSURE_BELOW_PERCENT;
  return {
    text:
      `Jev: "${chosen}" (confidence ${share(answer.confidence)}).` +
      (ranked.length > 0 ? ` Probabilities: ${ranked.map(([id, probability]) => `${names.get(id)} ${share(probability)}`).join(', ')}.` : '') +
      (outranked ? ' Another option has the higher probability: the answer contradicts itself, do not lean on it.' : unsure ? ' The confidence is low: do not lean on it.' : '') +
      ' Jev gives no reasons and saw only the question, options and context of this call.',
    line: `Jev decided: ${chosen} (confidence ${share(answer.confidence)})`,
  };
}

/** When the session reminds the model of the tool: for a prompt that looks like a decision, for every prompt, or never. */
export type DecideReminder = 'auto' | 'always' | 'off';

const DECISION_SHAPES: readonly RegExp[] = [
  // German
  /\bsoll(en|te|ten|st)?\s+(ich|wir|man|er|sie|es|claude)\b/i,
  /\bwelche[rsnm]?\b/i,
  /\b(was|wer|wie)\s+(ist|wäre|sind|passt|eignet)\b.*\b(besser|beste[nrs]?|am besten|sinnvoll(er)?|geeignet(er)?)\b/i,
  /\b(besser|lieber|sinnvoller|eher)\b.*\?/i,
  /\boder\b.*\?/i,
  /\b(entscheid\w*|empfiehl\w*|empfehl\w*|rätst|raten würdest|vergleich\w*|abwäg\w*|priorisier\w*|recherch\w*|lohnt\s+(es\s+)?sich|pro und contra|vor- und nachteile)\b/i,
  // English
  /\b(should|shall|would it be better|is it worth|do you recommend)\b/i,
  /\b(which|whether)\b/i,
  /\b(or)\b.*\?/i,
  /\b(decide|decision|recommend\w*|compare|comparison|trade-?offs?|pros and cons|prioriti[sz]e|research)\b/i,
  /\b(vs\.?|versus)\b/i,
];

/**
 * Whether a prompt reads like a decision to make or a research task: a
 * choice between things, a "should we", a comparison. A filter for when to
 * remind the model, generous on purpose: the model still judges whether
 * there is a decision to put to Jev.
 */
export function looksLikeDecision(prompt: string): boolean {
  const text = prompt.trim();
  if (text.length < 8 || text.startsWith('/')) return false;
  return DECISION_SHAPES.some((shape) => shape.test(text));
}

/** What the model reads beside such a prompt; the user never sees it. */
export function decideReminderText(toolName: string): string {
  return (
    `[fast-jev-compaction] The user has asked that Jev is consulted, visibly, on decisions and research. ` +
    `If this message asks you to choose between options, to decide whether to do something, or to research or compare something, ` +
    `call the ${toolName} tool before you answer (load it through tool search first if it is deferred): ` +
    `for a choice, the options the user named or the ones you would weigh; for research, the judgement call it ends in ` +
    `(which approach, source or product fits; whether what you found is enough). ` +
    `Pass Jev only what it needs as context, never secrets, customer, patient or other personal data. ` +
    `Then begin your answer with one line "JEV: <its answer> (<probability or confidence>)" and give your own reasoned decision: ` +
    `Jev is a second opinion without reasons, not the verdict, and you say so when you disagree with it. ` +
    `If the message holds no decision after all, or the tool was not asked or did not decide, begin with "JEV: nicht gefragt (<why>)" instead. ` +
    `Do not call the tool for anything else.`
  );
}
