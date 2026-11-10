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
  'Ask Jev (TypeSafe System One, a fast external decision model) one yes/no or multiple-choice question and get calibrated probabilities back. ' +
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
        criteria: Object.fromEntries(options.map((option) => [option.name, option.description ?? null])),
      },
    },
  };
}

function share(probability: number): string {
  return `${Math.round(Math.min(1, Math.max(0, probability)) * 100)}%`;
}

/** Between these a yes/no answer says nothing either way. */
const UNSURE_BELOW = 0.65;

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
    const yes = Math.min(1, Math.max(0, answer.noul));
    const leaning = Math.max(yes, 1 - yes);
    const verdict = leaning < UNSURE_BELOW ? 'cannot tell' : yes >= 0.5 ? 'yes' : 'no';
    return {
      text:
        `Jev: ${verdict} (probability of yes: ${share(yes)}).` +
        (verdict === 'cannot tell' ? ' This is close to a coin flip: do not lean on it.' : '') +
        ' Jev gives no reasons and saw only the question and context of this call.',
      line: `Jev decided: ${verdict} (yes ${share(yes)})`,
    };
  }
  if (!answer || !('choice' in answer) || typeof answer.choice !== 'string') throw new Error('Jev gave no choice');
  const known = new Set(request.options.map((option) => option.name));
  if (!known.has(answer.choice)) throw new Error('Jev chose an option that was not offered');
  const ranked = Object.entries(answer.probabilities)
    .filter(([name, probability]) => known.has(name) && Number.isFinite(probability))
    .sort((a, b) => b[1] - a[1]);
  const unsure = answer.confidence < UNSURE_BELOW;
  return {
    text:
      `Jev: "${answer.choice}" (confidence ${share(answer.confidence)}).` +
      (ranked.length > 0 ? ` Probabilities: ${ranked.map(([name, probability]) => `${name} ${share(probability)}`).join(', ')}.` : '') +
      (unsure ? ' The confidence is low: do not lean on it.' : '') +
      ' Jev gives no reasons and saw only the question, options and context of this call.',
    line: `Jev decided: ${answer.choice} (confidence ${share(answer.confidence)})`,
  };
}
