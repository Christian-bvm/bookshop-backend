import "dotenv/config";
import express from "express";
import Stripe from "stripe";
import nodemailer from "nodemailer";

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Stripe Webhook (RAW body!)
app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;

    const firstName = session.metadata?.firstName || "";
    const lastName = session.metadata?.lastName || "";
    const qty = Math.max(1, Math.min(10, parseInt(session.metadata?.quantity || "1", 10) || 1));

    const buyerEmail = session.customer_email || "";

    const ship = session.shipping_details;
    const addr = ship?.address;

    const addressText = addr
      ? `${ship?.name || ""}\n${addr.line1 || ""}${addr.line2 ? "\n" + addr.line2 : ""}\n${addr.postal_code || ""} ${addr.city || ""}\n${addr.country || ""}`
      : "(keine Versandadresse erhalten)";

    const unitPriceEur = 20;
    const totalEur = (qty * unitPriceEur).toFixed(2);

    const transporter = nodemailer.createTransport({
      host: "mail.gmx.net",
      port: Number(process.env.SMTP_PORT || 587),
      secure: String(process.env.SMTP_PORT) === "465",
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      requireTLS: String(process.env.SMTP_PORT) !== "465"
    });

    const bookName = process.env.BOOK_NAME || "Buch";

    // Mail an Käufer
    if (buyerEmail) {
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
    }

    // Mail an dich (ADMIN_EMAIL)
    await transporter.sendMail({
      from: process.env.SMTP_FROM,
      to: process.env.ADMIN_EMAIL,
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

Stripe Session: ${session.id}`
    });
  }

  res.json({ received: true });
});

app.use(express.json());

// CORS für Squarespace (www)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "https://www.bildervonmorgen.org");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.post("/create-checkout-session", async (req, res) => {
  const { firstName, lastName, email, quantity } = req.body || {};
  if (!firstName || !lastName || !email) return res.status(400).json({ error: "Missing fields" });

  const q = Math.max(1, Math.min(10, parseInt(quantity, 10) || 1));

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    customer_email: email,

    shipping_address_collection: { allowed_countries: ["AT", "DE", "CH"] },

    line_items: [{
      price_data: {
        currency: "eur",
        product_data: { name: process.env.BOOK_NAME || "Mein Buch" },
        unit_amount: 2000
      },
      quantity: q
    }],

    success_url: `${process.env.PUBLIC_SITE_URL}/success`,
    cancel_url: `${process.env.PUBLIC_SITE_URL}/cancel`,
    metadata: { firstName, lastName, quantity: String(q) }
  });

  res.json({ url: session.url });
});

app.get("/health", (req, res) => res.send("ok"));

app.listen(process.env.PORT || 4242, () => console.log("Server running"));
