import { redirect } from 'next/navigation';

/**
 * Legacy evaluator URL. Provider settlement is an Anchor platform service,
 * not a marketplace persona, so its proof now lives in the buyer journey.
 */
export default function ProviderRedirect() {
  redirect('/company#platform-services');
}
