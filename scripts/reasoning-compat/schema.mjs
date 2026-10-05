/** Keep public settings schemas explicit so unknown fields cannot bypass validation. */
export function modelReasoningSchema(z) {
  const effort = z.object({ id: z.string().required(), name: z.string().required(), wireValue: z.union([z.string(), z.const(null)]) });
  return z.object({
    capability: z.object({
      status: z.union(['known', 'unknown', 'unsupported']).required(),
      source: z.union(['endpoint', 'catalog', 'adapter']).required(),
      authoritative: z.boolean(),
      endpoint: z.string(),
      api: z.string(),
      efforts: z.array(effort).required(),
    }).default(undefined),
    manualEfforts: z.array(effort).default(undefined),
    manualAcknowledged: z.boolean(),
    selected: z.array(z.string()).required(),
    defaultEffort: z.string(),
  }).default(undefined);
}
