import { parseClock } from '../ai/text';
import type { Claim, Game, PlayerId } from '../engine';

const ACCUSING = /\b(sus|suspicious|sussy|killer|killed|murder\w*|saboteur|impostor|liar|lying|lied|vote|it was|did it|guilty|eject|kick)\b/i;
const CLEARING = /\b(not|isn'?t|wasn'?t|innocent|trust|cleared?|safe|with me)\b/i;
const SELF = /\bI(?:'m| am| was)\b/i;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentions = (text: string, name: string) => new RegExp(`\\b${escape(name)}\\b`, 'i').test(text);

/**
 * Read a typed chat line the way the AIs read each other's structured lines:
 * who it accuses ("Vex is sus"), and where the speaker says they were
 * ("I was in the Lab at 1:10 with Mo"). Best-effort; plain text still goes out as-is.
 */
export function parseHumanChat(text: string, game: Game, speaker: PlayerId): { accuse?: PlayerId; claims?: Claim[] } {
  const others = game.players.filter((p) => p.id !== speaker);
  const named = others.filter((p) => mentions(text, p.name));
  const out: { accuse?: PlayerId; claims?: Claim[] } = {};

  if (named.length > 0 && ACCUSING.test(text) && !CLEARING.test(text)) out.accuse = named[0].id;

  if (SELF.test(text)) {
    const area = [...game.map.areas].sort((a, b) => b.name.length - a.name.length).find((a) => mentions(text, a.name));
    if (area) {
      const time = /\b(?:at|around|about)\s+(\d{1,2}:\d{2})\b/i.exec(text);
      const at = time ? parseClock(time[1]) : null;
      const saw = /\b(saw|with|seen)\b/i.test(text) ? named.map((p) => p.id) : [];
      out.claims = [{ areaId: area.id, atTick: at !== null && at <= game.tick ? at : null, saw }];
    }
  }
  return out;
}
