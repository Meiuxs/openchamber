import { asNonEmptyString } from '../shared/guards.js';

export function registerSmallModelRoutes(app, { getSmallModelService }) {
  app.get('/api/small-model', async (req, res) => {
    try {
      const { describeSmallModel, listAuthenticatedProviders } = await getSmallModelService();
      const directory = typeof req.query.directory === 'string' ? req.query.directory : undefined;
      const resolved = await describeSmallModel({
        directory,
        preferredProviderID: typeof req.query.providerID === 'string' ? req.query.providerID : undefined,
        preferredModelID: typeof req.query.modelID === 'string' ? req.query.modelID : undefined,
      });
      res.json({
        available: Boolean(resolved),
        model: resolved,
        authenticatedProviders: await listAuthenticatedProviders(directory),
      });
    } catch (error) {
      console.error('Failed to resolve small model:', error);
      res.status(500).json({ error: error.message || 'Failed to resolve small model' });
    }
  });

  app.post('/api/small-model/generate', async (req, res) => {
    try {
      const { generateSmallModelText } = await getSmallModelService();
      const { prompt, system, maxOutputTokens, model, directory, preferredProviderID, preferredModelID } = req.body || {};
      const result = await generateSmallModelText({
        prompt,
        system,
        maxOutputTokens,
        model,
        directory,
        preferredProviderID,
        preferredModelID,
      });
      res.json(result);
    } catch (error) {
      // OpenCode tags a provider that refused the call itself (connection
      // refused, a 5xx from upstream). The message names the cause, and asking
      // the same provider again through another route cannot change the answer.
      // A rate limit or overloaded provider stays on the generic path: another
      // model on that provider may still answer.
      const providerError = error?._tag === 'ProviderRequestError' && error.reason === 'provider';
      const statusCode = providerError ? 502 : Number(error?.statusCode) || 500;
      if (statusCode >= 500) {
        console.error('Small model generation failed:', error);
      }
      const message = asNonEmptyString(error?.message) || 'The request failed';
      res.status(statusCode).json({
        error: providerError
          ? `The provider refused: ${message}`
          : statusCode === 404 || error?.code === 'small-model-unavailable' || error?.code === 'generation-timeout'
            ? (error.message || 'No small model is available')
            : 'The selected Small Model could not complete this action. Choose another model in Settings → Sessions → Small Model and try again.',
        ...(providerError ? { code: 'provider-error' } : error?.code ? { code: error.code } : {}),
      });
    }
  });
}
