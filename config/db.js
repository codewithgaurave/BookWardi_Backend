import mongoose from "mongoose";

export const connectDB = async () => {
  const primaryUri = process.env.MONGODB_URI || process.env.MONGO_URI;
  const localUri = "mongodb://127.0.0.1:27017/bookvardi_db_final";

  if (primaryUri) {
    try {
      await mongoose.connect(primaryUri, {
        maxPoolSize: 25,
        minPoolSize: 5,
        socketTimeoutMS: 45000,
        serverSelectionTimeoutMS: 8000,
        maxIdleTimeMS: 30000
      });
      console.log("✅ MongoDB Connected successfully to Atlas:", primaryUri.split("@").pop().split("?")[0]);
      return;
    } catch (error) {
      console.warn("⚠️ MongoDB Atlas Connection Failed (" + error.message + "). Attempting local fallback...");
    }
  } else {
    console.warn("⚠️ MONGODB_URI environment variable is missing in process.env!");
  }

  try {
    await mongoose.connect(localUri, {
      maxPoolSize: 20,
      minPoolSize: 2,
      serverSelectionTimeoutMS: 8000,
      socketTimeoutMS: 30000
    });
    console.log("✅ MongoDB Connected successfully to Local DB:", localUri);
  } catch (error) {
    console.error("⚠️ MongoDB Connection Error:", error.message);
    console.warn("ℹ️ Server operating in offline mock mode.");
  }
};

export default connectDB;