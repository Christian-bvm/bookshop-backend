import "dotenv/config";
import express from "express";
import Stripe from "stripe";
import nodemailer from "nodemailer";

const app = express();

if (!process.env.STRIPE_SECRET_KEY) throw new Error("Missing env: STRIPE_SECRET_KEY");
if (!process.env.PUBLIC_SITE_URL) throw new Error("Missing env: PUBLIC_SITE_URL");
if (!process.env.ADMIN_EMAIL) throw new Error("Missing env: ADMIN_EMAIL");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Webhook: RAW body
app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("Webhook Error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log("WEBHOOK HIT");
  console.log("EVENT TYPE:", event.type);

  if (event.type === "checkout.session.completed") {
    try {
      const session = event.data.object;

      // Session sicherheitshalber nochmal vollständig laden
      const fullSession = await stripe.checkout.sessions.retrieve(session.id);

      const firstName = fullSession.metadata?.firstName || "";
      const lastName = fullSession.metadata?.lastName || "";
      const qty = Math.max(1, Math.min(10, parseInt(fullSession.metadata?.quantity || "1", 10) || 1));
      const buyerEmail = fullSession.customer_email || fullSession.customer_details?.email || "";

      // Versandadresse robust auslesen
      const shippingName =
        fullSession.shipping_details?.name ||
        fullSession.customer_details?.name ||
        "";

      const addr =
        fullSession.shipping_details?.address ||
        fullSession.customer_details?.address ||
        null;

      const addressText = addr
        ? `${shippingName}
${addr.line1 || ""}${addr.line2 ? "\n" + addr.line2 : ""}
${addr.postal_code || ""} ${addr.city || ""}
${addr.state ? addr.state + "\n" : ""}${addr.country || ""}`
        : "(keine Versandadresse erhalten)";

      console.log("ADDRESS TEXT:", addressText);

      const unitPriceEur = 21;
      const totalEur = (qty * unitPriceEur).toFixed(2);
      const bookName = process.env.BOOK_NAME || "Buch";

      const transporter = nodemailer.createTransport({
        host: "mail.gmx.net",
        port: Number(process.env.SMTP_PORT || 587),
        secure: String(process.env.SMTP_PORT) === "465",
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS
        },
        requireTLS: String(process.env.SMTP_PORT) !== "465"
      });

      // Käufer-Mail
      if (buyerEmail) {
        try {
          await transporter.sendMail({
            from: process.env.SMTP_FROM,
            to: buyerEmail,
            subject: `Bestätigung: ${bookName}`,
            text:
`Danke für deine Bestellung!

Buch: ${bookName}
Stückpreis: ${unitPriceEur.toFixed(2)} EUR
Anzahl: ${qty}
Gesamt: ${totalEur} EUR
Versand: Gratis (AT/DE/CH)

Name: ${firstName} ${lastName}

Versandadresse:
${addressText}

Wir versenden so schnell wie möglich.`
          });
          console.log("Buyer email sent");
        } catch (mailErr) {
          console.error("Buyer email failed:", mailErr.message);
        }
      }

      // Admin-Mail
      try {
        const adminRecipients = [
              process.env.ADMIN_EMAIL,
              process.env.ADMIN_EMAIL2
            ].filter(Boolean).join(", ");

        await transporter.sendMail({
          from: process.env.SMTP_FROM,
          to: adminRecipients,
          subject: `Neue Buchbestellung (${bookName})`,
          text:
`Erfolgreich bezahlt:

Buch: ${bookName}
Stückpreis: ${unitPriceEur.toFixed(2)} EUR
Anzahl: ${qty}
Gesamt: ${totalEur} EUR
Versand: Gratis (AT/DE/CH)

Name: ${firstName} ${lastName}
E-Mail: ${buyerEmail}

Versandadresse:
${addressText}

Stripe Session: ${fullSession.id}`
        });
        console.log("Admin email sent");
      } catch (mailErr) {
        console.error("Admin email failed:", mailErr.message);
      }
    } catch (err) {
      console.error("Webhook processing failed:", err.message);
    }
  }

  res.json({ received: true });
});

// CORS
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json());

app.post("/create-checkout-session", async (req, res) => {
  const { firstName, lastName, email, quantity } = req.body || {};
  if (!firstName || !lastName || !email) {
    return res.status(400).json({ error: "Missing fields" });
  }

  const q = Math.max(1, Math.min(10, parseInt(quantity, 10) || 1));

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    customer_email: email,
    billing_address_collection: "auto",
    shipping_address_collection: {
      allowed_countries: ["AT", "DE", "CH"]
    },
    line_items: [
      {
        price_data: {
          currency: "eur",
          product_data: { name: process.env.BOOK_NAME || "Mein Buch" },
          unit_amount: 2100
        },
        quantity: q
      }
    ],
    success_url: `${process.env.PUBLIC_SITE_URL}/success`,
    cancel_url: `${process.env.PUBLIC_SITE_URL}/cancel`,
    metadata: {
      firstName,
      lastName,
      quantity: String(q)
    }
  });

  res.json({ url: session.url });
});

app.get("/health", (req, res) => res.send("ok"));

app.get("/debug-cors", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");
  res.send(JSON.stringify({
    ok: true,
    origin: req.headers.origin || null,
    time: new Date().toISOString()
  }));
});

app.get("/debug-version", (req, res) => {
  res.setHeader("X-MAIA-VERSION", "v2");
  res.json({ ok: true, version: "v2" });
});

app.listen(process.env.PORT || 4242, () => console.log("Server running"));
