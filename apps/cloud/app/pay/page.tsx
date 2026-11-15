import PaddleCheckout from "../../components/PaddleCheckout";
import { getCloud } from "../../lib/cloud";

export const dynamic = "force-dynamic";

/**
 * Paddle's "default payment link" (Paddle > Checkout > Checkout configuration) must point at this page:
 *   https://<this server>/pay
 * Paddle sends customers here with ?_ptxn=<transaction> and Paddle.js opens the checkout. Public on purpose:
 * it contains no account data, only the public client-side token.
 */
export default function PayPage() {
  const { paddleClientToken, paddleEnvironment } = getCloud().config;
  return (
    <>
      <h1>Checkout</h1>
      {paddleClientToken ? (
        <PaddleCheckout token={paddleClientToken} environment={paddleEnvironment} />
      ) : (
        <p className="flash error">Paddle checkout is not set up on this server (ARD_PADDLE_CLIENT_TOKEN is missing).</p>
      )}
    </>
  );
}
