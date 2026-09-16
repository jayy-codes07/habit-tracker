/**
 * Generates a VAPID key pair for Web Push.
 *
 *   npm run vapid
 *
 * The pair identifies THIS server to the browser's push service: the public key
 * goes into every subscription the browser makes, and the private key signs
 * every send. Generate it once and keep it — changing it invalidates every
 * subscription already made against the old one, and each device has to be
 * registered again from the settings screen.
 *
 * Prints the two .env lines and nothing else, so the output can be appended
 * straight to the file. The private key is a secret: it belongs in .env, which
 * is gitignored, and nowhere near a payload.
 *
 * It does not write .env itself. A script that edits the file holding your
 * database password and your session secret is a script that will one day
 * truncate it.
 */
import webpush from "web-push";

const { publicKey, privateKey } = webpush.generateVAPIDKeys();

console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
