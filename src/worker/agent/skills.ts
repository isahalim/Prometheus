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
    summary: "Turn the cube into the big primary masses fast: global ops and primitives.",
    triggers: /\b(block|start|shape|rough|base|silhouette|primary|make|build|sculpt)\b/i,
    body: `BLOCKOUT (primary forms — do this before anything else)
- Kill the box in one move: sculpt_global spherize 0.6-0.9 (round), then sculpt_global scale to the target's overall proportions
  (e.g. bust [0.85, 1.1, 0.9], long animal body [0.7, 0.6, 1.4]).
- Add each major mass as a primitive with add_shape, sunk ~30% into the existing form, blend 0.15-0.3:
  body/torso = ellipsoid, head = sphere/ellipsoid, limbs/neck/tail = capsule (center -> end), base/plinth = cylinder or box.
- Carve big negative spaces with add_shape mode=subtract (eye sockets, the gap between legs, a mouth cavity).
- Then sculpt_form pull/push (radius 0.3-0.8) to fix silhouettes in front and right views. Check top view for depth.
- Only move to secondary forms when front AND right silhouettes read as the target.`,
  },
  {
    name: "head",
    summary: "Heads, faces and busts: proportions, landmarks, order of work.",
    triggers: /\b(head|face|bust|portrait|eye|nose|mouth|ear|skull|chin|jaw|cheek)\b/i,
    body: `HEAD / FACE (model faces +Z; head height H_h from chin to crown)
- Skull: ellipsoid radii ~[0.62, 0.78, 0.7] centred ~(0, 0.15, 0); jaw/chin: ellipsoid [0.42, 0.3, 0.42] at (0, -0.45, 0.18), blend 0.25.
- Neck (bust): cylinder axis [0,1,0] radius 0.3 minor 0.35 at (0, -0.85, -0.05); shoulders/plinth: ellipsoid [1.0, 0.3, 0.55] at (0, -1.25, -0.05).
- Landmarks: eye line at the head's vertical middle; eyes one eye-width apart (centres x = ±0.22); nose base halfway eye line -> chin;
  mouth 1/3 from nose base to chin; ears from brow line to nose base, on the sides just behind the middle (z ≈ -0.05).
- Order: skull+jaw masses -> brow ridge (sculpt_form add along y≈0.2, z front) -> eye sockets (add_shape subtract sphere r≈0.14,
  x=±0.22, z just behind the front surface) -> eyeballs (add_shape sphere r≈0.1 inside the sockets) -> nose (capsule from (0, 0.05, zf-0.05)
  to (0, -0.2, zf+0.15), r 0.08) -> lips (crease stroke for the mouth line, clay above and below) -> ears (ellipsoid [0.06, 0.18, 0.12]
  at x=±0.62, sunk in, symmetry true) -> cheekbones (clay).
- Use the right panel to check the profile: forehead, nose projection, lips, chin in that order from top.`,
  },
  {
    name: "creature",
    summary: "Animals and creatures: gesture, masses, limbs from primitives.",
    triggers: /\b(animal|creature|dragon|cat|dog|bird|fish|monster|body|torso|leg|arm|tail|wing|horse|bear|owl|frog|rabbit|bunny|fox|dinosaur)\b/i,
    body: `CREATURE
- Decide the pose and gesture line first (side view). Quadrupeds face +Z with the body along Z; standing figures along Y.
- Masses as primitives: ribcage + pelvis = two ellipsoids, neck = capsule, head = sphere/ellipsoid, snout = capsule pointing +Z,
  legs = capsules from the body down to y ≈ bbox bottom (paired via symmetry), tail = capsule chain, wings = flattened ellipsoids.
- Fuse every junction with blend 0.15-0.25 and then sculpt_form smooth over the seam.
- Keep limbs thick enough to read (radius >= 0.1) and feet on a common ground plane (same min y).
- Character comes from exaggeration: big head, small body (cute) or the reverse (heroic); push it.`,
  },
  {
    name: "objects",
    summary: "Vessels, props, stylised objects, architecture from primitives.",
    triggers: /\b(vase|cup|bowl|vessel|pot|bottle|lamp|chair|table|house|tower|castle|car|rocket|ship|tree|mushroom|snowman|apple|fruit)\b/i,
    body: `OBJECTS
- Lathe-like forms (vase, bottle, mushroom): sculpt_global scale to the overall silhouette, then add_shape cylinders/tori along Y
  (axis [0,1,0]) for rims, bands and lips; carve openings with subtract cylinders.
- Stacked forms (snowman, tower): spheres/boxes/cylinders on the Y axis, each sunk into the one below, blend 0.1.
- Crisp design objects: smaller blend (0.03-0.06), flatten for planes, pinch along edges.`,
  },
  {
    name: "hard-surface",
    summary: "Planes, bevels and crisp edges on mechanical or architectural forms.",
    triggers: /\b(hard|mechanical|robot|panel|bevel|crisp|sharp|edge|building|helmet|armor)\b/i,
    body: `HARD SURFACE
- Build from boxes and cylinders with small blend (0.02-0.06); carve recesses with subtract boxes.
- "flatten" (sculpt_form, intensity 0.8) makes planes; "pinch" along an edge sharpens it; crease strokes cut panel lines (r 0.03-0.06).
- Keep strokes straight: 2 points, far apart, in an orthographic view.`,
  },
  {
    name: "cleanup",
    summary: "Smooth noise, fuse seams, fix lumpy or stretched areas, finishing.",
    triggers: /\b(smooth|clean|lumpy|bumpy|noise|tidy|polish|fix|finish|refine)\b/i,
    body: `CLEANUP / FINISHING
- Stretched or spiky areas: remesh first, then sculpt_form smooth (radius slightly larger than the bump, intensity 0.5-0.8).
- Seams between fused primitives: sculpt_form smooth along the junction, then clay strokes to rebuild a clean transition.
- Don't smooth across intended sharp features (creases, lips, eyelids) — work beside them.
- Whole-model sculpt_global smooth 0.1-0.2 only at the very end, if at all.`,
  },
  {
    name: "follow",
    summary: "How to read the human's strokes and help without taking over.",
    triggers: /\b(help|continue|same|mirror|match|finish|like this|follow)\b/i,
    body: `FOLLOWING THE HUMAN
- Their last strokes are their intent. Continue a pattern (scales, ribs, hair strands) with the same brush/radius at the next position along it.
- If they work one side with symmetry off, offer the mirrored stroke on the other side.
- Never stroke on top of the region they are actively working (the newest hotspot) unless asked; work adjacent areas.
- When unsure, update intent and ask one short question instead of sculpting.`,
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
