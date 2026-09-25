import { WorkerMailer } from "worker-mailer";
import type { Env } from "./db";

export interface Email {
  to: string;
  subject: string;
  text: string;
}

export async function sendEmail(env: Env, email: Email): Promise<void> {
  if (env.EMAIL_MODE === "dev") {
    await env.DB.prepare("INSERT INTO dev_outbox (to_addr, subject, body) VALUES (?, ?, ?)")
      .bind(email.to, email.subject, email.text)
      .run();
    console.log(`[dev email] to=${email.to} subject=${email.subject}\n${email.text}`);
    return;
  }
  if (!env.SMTP_PASS) throw new Error("SMTP_PASS is not set");
  await WorkerMailer.send(
    {
      host: env.SMTP_HOST,
      port: Number(env.SMTP_PORT),
      secure: true,
      authType: ["plain", "login"],
      credentials: { username: env.SMTP_USER, password: env.SMTP_PASS },
    },
    {
      from: { name: env.APP_NAME, email: env.SMTP_USER },
      to: email.to,
      subject: email.subject,
      text: email.text,
    },
  );
}
