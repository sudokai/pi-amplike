/**
 * Parse an exact provider/model-id reference at the first separator so model IDs may contain more.
 * Rejects empty parts and references without a separator (no bare ids, aliases, or fuzzy tokens).
 */
export function parseExactModelRef(reference: string): { provider: string; modelId: string } | undefined {
	const trimmed = reference.trim();
	if (!trimmed) return undefined;
	const separator = trimmed.indexOf("/");
	if (separator <= 0 || separator === trimmed.length - 1) return undefined;
	const provider = trimmed.slice(0, separator).trim();
	const modelId = trimmed.slice(separator + 1).trim();
	if (!provider || !modelId) return undefined;
	return { provider, modelId };
}
