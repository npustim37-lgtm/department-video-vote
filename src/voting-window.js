export function votingPhase(settings, now = Date.now()) {
  const mode = settings?.mode || 'open';
  if (mode === 'closed') return 'closed';
  const end = settings?.closes_at ? Date.parse(settings.closes_at) : null;
  if (mode === 'scheduled') {
    const start = settings?.opens_at ? Date.parse(settings.opens_at) : null;
    if (start == null || end == null || Number.isNaN(start) || Number.isNaN(end)) return 'closed';
    if (now < start) return 'upcoming';
  }
  return end != null && !Number.isNaN(end) && now >= end ? 'ended' : 'open';
}
