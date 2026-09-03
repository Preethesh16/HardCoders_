import { redirect } from 'next/navigation';

/**
 * Legacy evaluator URL. Audit and reconciliation are automated Anchor
 * services, exposed to the buyer and seller as contextual technical proof.
 */
export default function AdminRedirect() {
  redirect('/company#platform-services');
}
