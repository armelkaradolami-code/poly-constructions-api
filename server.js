import express from 'express';
import { Resend } from 'resend';

const app = express();
app.use(express.json());

const resend = new Resend(process.env.RESEND_API_KEY);

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.post('/api/send-email', async (req, res) => {
  try {
    const { to, subject, message } = req.body;

    const result = await resend.emails.send({
      from: 'onboarding@resend.dev',
      to,
      subject,
      html: message
    });

    res.json({ success: true, result });
  } catch (error) {
    console.error('Erreur envoi email:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
