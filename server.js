import dotenv from 'dotenv';

dotenv.config();

// Import app
const { default: app, allowedOrigins } = await import('./app.js');

const PORT = process.env.PORT || 5000;

// Start Server with Graceful Error Handling
const server = app.listen(PORT, () => {
  console.log(`🚀 Backend is running successfully on port ${PORT}`);
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(
      `⚠️ Port ${PORT} is currently occupied by another process. Please stop existing background server processes.`
    );
  } else {
    console.error('Server error:', error);
  }
});