import nodemailer from "nodemailer";
import { site } from "@/data/site";

export async function POST(request: Request) {
  const { name, contact, message } = await request.json();

  if (!name || !contact || !message) {
    return Response.json({ error: "Missing fields" }, { status: 400 });
  }

  const user = process.env.CONTACT_GMAIL_USER;
  const pass = process.env.CONTACT_GMAIL_APP_PASSWORD;

  if (!user || !pass) {
    return Response.json({ error: "Email is not configured" }, { status: 500 });
  }

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user, pass },
  });

  try {
    await transporter.sendMail({
      from: `"Magic Suites Website" <${user}>`,
      to: site.email,
      replyTo: contact.includes("@") ? contact : undefined,
      subject: `Website inquiry from ${name}`,
      text: `Name: ${name}\nPhone/Email: ${contact}\n\n${message}`,
    });
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "Failed to send" }, { status: 500 });
  }
}
