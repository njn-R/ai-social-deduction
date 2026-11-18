import type { JsonSchema } from './llm/types';

const text = (maxLength: number): JsonSchema => ({ type: 'string', maxLength });
const oneOf = (values: string[]): JsonSchema => ({ type: 'string', enum: [...new Set(values)] });
const object = (properties: Record<string, JsonSchema>): JsonSchema => ({
  type: 'object',
  additionalProperties: false,
  properties,
  required: Object.keys(properties),
});

export const INTENTS = ['accuse', 'defend', 'question', 'agree', 'share_info', 'deflect', 'stay_quiet'] as const;

/** One line in a meeting. Field order matters: think first, then speak. */
export function turnSchema(o: { others: string[]; everyone: string[]; areas: string[]; thoughtChars: number }) {
  return {
    name: 'meeting_turn',
    schema: object({
      thoughts: text(o.thoughtChars),
      intent: oneOf([...INTENTS]),
      say: text(240),
      accuse: oneOf([...o.others, 'nobody']),
      claims: {
        type: 'array',
        maxItems: 2,
        items: object({
          where: oneOf(o.areas),
          at: text(5),
          saw: { type: 'array', maxItems: 3, items: oneOf(o.everyone) },
        }),
      },
    }),
  };
}

export function voteSchema(o: { others: string[]; thoughtChars: number }) {
  return { name: 'vote', schema: object({ thoughts: text(o.thoughtChars), vote: oneOf([...o.others, 'skip']) }) };
}

export function crewPlanSchema(o: { others: string[]; thoughtChars: number }) {
  return {
    name: 'crew_plan',
    schema: object({ thoughts: text(o.thoughtChars), buddy: oneOf([...o.others, 'nobody']), avoid: oneOf([...o.others, 'nobody']) }),
  };
}

export function saboteurPlanSchema(o: { crew: string[]; others: string[]; thoughtChars: number }) {
  return {
    name: 'saboteur_plan',
    schema: object({
      thoughts: text(o.thoughtChars),
      target: oneOf([...o.crew, 'anyone']),
      style: oneOf(['patient', 'normal', 'aggressive']),
      buddy: oneOf([...o.others, 'nobody']),
    }),
  };
}
