/**
 * Skills: short, focused playbooks the agent can load into its context.
 *
 * Only the one-line index of every skill is always in the prompt. A skill's
 * body is included when the agent asks for it (`use_skill`, which persists
 * for the session, at most MAX_ACTIVE) or when the human's words match its
 * triggers — so context grows with what the session is about, not with how
 * many skills exist.
 */

export interface Skill {
  name: string;
  summary: string;
  triggers: RegExp;
  body: string;
}

export const MAX_ACTIVE_SKILLS = 2;

export const SKILLS: Skill[] = [
  {
    name: "blockout",
    summary: "Turn the cube into big primary forms before any detail.",
    triggers: /\b(block|start|shape|rough|base|silhouette|primary)\b/i,
    body: `BLOCKOUT
- Work large: radius 0.35-0.6, strength 0.4-0.8. Detail before the silhouette reads is wasted.
- First kill the box: smooth the 12 cube edges with "smooth" (radius 0.4) or "inflate" the faces you want round.
- Build mass with "grab" (drag outward along the silhouette in front/right views) and "clay"; carve with "draw" inverted.
- Check two orthogonal silhouettes (front + right) every turn; fix the one that is furthest from the target.
- Keep symmetry on for anything bilaterally symmetric.`,
  },
  {
    name: "head",
    summary: "Proportions and landmarks for heads, faces and busts.",
    triggers: /\b(head|face|bust|portrait|eye|nose|mouth|ear|skull|chin|jaw|cheek)\b/i,
    body: `HEAD / FACE (front view, panel coords)
- Eye line at the vertical middle of the head (y ~0.5 of the head's extent); eyes one eye-width apart.
- Nose base ~halfway between eye line and chin; mouth ~1/3 from nose base to chin. Ears span brow line to nose base, on the side view just behind the middle.
- Order: skull egg (inflate/grab) -> brow ridge and cheekbones (clay) -> eye sockets (draw inverted, radius 0.12) -> nose wedge (clay/grab, right view for projection) -> lips (crease for the mouth line, then pinch) -> ears (grab out in right view).
- Sockets and the mouth line are the strongest read; do them early with symmetry on.`,
  },
  {
    name: "creature",
    summary: "Animals and creatures: gesture, masses, limbs.",
    triggers: /\b(animal|creature|dragon|cat|dog|bird|fish|monster|body|torso|leg|arm|tail|wing)\b/i,
    body: `CREATURE
- Establish the gesture line first (one long "grab" or "draw" stroke along the spine in the right view).
- Masses: ribcage and pelvis as two eggs, neck and head as a smaller pair. Limbs come from "grab" pulls out of the masses, then "clay" to thicken.
- Use top view to keep the spine straight (or deliberately curved).
- A cube has limited resolution: keep limbs thick (radius >= 0.12) or they tear thin.`,
  },
  {
    name: "hard-surface",
    summary: "Planes, bevels and crisp edges on mechanical or architectural forms.",
    triggers: /\b(hard|mechanical|robot|panel|bevel|crisp|sharp|edge|building|helmet|armor)\b/i,
    body: `HARD SURFACE
- "flatten" makes planes: stroke across a face in the view that sees it head-on, radius 0.3+.
- "pinch" along an edge sharpens it; "crease" cuts panel lines (small radius 0.04-0.08, strength 0.5).
- Keep strokes straight: 2 points, far apart, in an orthographic view.`,
  },
  {
    name: "cleanup",
    summary: "Smooth noise, even out bumps, fix lumpy or torn areas.",
    triggers: /\b(smooth|clean|lumpy|bumpy|noise|tidy|polish|fix)\b/i,
    body: `CLEANUP
- "smooth" with radius slightly larger than the bump, strength 0.5-0.8, short strokes that cover the area once.
- Do not smooth across intended sharp features (creases, lips, eyelids) — stroke beside them.
- Hotspots in the geometry summary point at where the last edits were; lumps usually live there.`,
  },
  {
    name: "follow",
    summary: "How to read the human's strokes and help without taking over.",
    triggers: /\b(help|continue|same|mirror|match|finish|like this|follow)\b/i,
    body: `FOLLOWING THE HUMAN
- Their last strokes are their intent. Continue a pattern (e.g. scales, ribs, hair strands) with the same brush/radius at the next position along it.
- If they work one side with symmetry off, offer the mirrored stroke on the other side.
- Never stroke on top of the region they are actively working (the newest hotspot) unless asked; work adjacent areas.
- When unsure, update intent and say one short question instead of sculpting.`,
  },
];

export function skillIndex(): string {
  return SKILLS.map((s) => `- ${s.name}: ${s.summary}`).join("\n");
}

/** Skills the session has activated, plus any the human's message triggers, capped. */
export function selectSkills(active: string[], message: string | undefined): Skill[] {
  const chosen: Skill[] = [];
  for (const name of active) {
    const skill = SKILLS.find((s) => s.name === name);
    if (skill && !chosen.includes(skill)) chosen.push(skill);
  }
  if (message) {
    for (const skill of SKILLS) {
      if (chosen.length >= MAX_ACTIVE_SKILLS + 1) break;
      if (!chosen.includes(skill) && skill.triggers.test(message)) chosen.push(skill);
    }
  }
  return chosen.slice(0, MAX_ACTIVE_SKILLS + 1);
}
