const express = require("express");
const multer = require("multer");
const fetch = require("node-fetch");
const path = require("path");
const fs = require("fs");
const cloudinary = require('cloudinary').v2;
require("dotenv").config();

const app = express();
const upload = multer({ dest: "uploads/" });

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;

app.use(express.static("public"));

app.post("/generate-texture", upload.single("image"), async (req, res) => {
  try {
    console.log("=== Starting texture generation with Cloudinary ===");
    
    if (!req.file) {
      console.log("ERROR: No image file provided");
      return res.status(400).json({ error: "No image file provided" });
    }

    console.log("File received:", {
      filename: req.file.filename,
      originalname: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size
    });

    // Check if API tokens exist
    if (!REPLICATE_API_TOKEN) {
      console.log("ERROR: REPLICATE_API_TOKEN not found in environment variables");
      return res.status(500).json({ error: "Replicate API token not configured" });
    }

    if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
      console.log("ERROR: Cloudinary credentials not found in environment variables");
      return res.status(500).json({ error: "Cloudinary credentials not configured" });
    }

    const imagePath = path.join(__dirname, req.file.path);
    console.log("Image path:", imagePath);

    // Upload to Cloudinary
    console.log("Uploading to Cloudinary...");
    const cloudinaryResult = await cloudinary.uploader.upload(imagePath, {
      folder: 'avatar-vton',
      resource_type: 'auto',
      quality: 'auto',
      fetch_format: 'auto'
    });

    console.log("Cloudinary upload successful:", {
      public_id: cloudinaryResult.public_id,
      secure_url: cloudinaryResult.secure_url,
      format: cloudinaryResult.format,
      width: cloudinaryResult.width,
      height: cloudinaryResult.height,
      bytes: cloudinaryResult.bytes
    });

    const hostedURL = cloudinaryResult.secure_url;

    // Clean up uploaded file
    fs.unlinkSync(imagePath);
    console.log("Local file cleaned up");

    const requestBody = {
      version: "cbf059cce30a22d821a3c86309ae3b037dcd505dd2eba47f8ea6eba20adced85",
      input: {
        image: hostedURL,
        prompt: "tileable fabric pattern",
      },
    };

    console.log("Making Replicate API call with body:", {
      version: requestBody.version,
      input: {
        prompt: requestBody.input.prompt,
        image: hostedURL
      }
    });

    // Call Replicate with Cloudinary URL
    const replicateRes = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: {
        Authorization: `Token ${REPLICATE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    console.log("Replicate API response status:", replicateRes.status);
    console.log("Replicate API response headers:", Object.fromEntries(replicateRes.headers));

    if (!replicateRes.ok) {
      const errorText = await replicateRes.text();
      console.error("Replicate API failed with status:", replicateRes.status);
      console.error("Replicate API error response:", errorText);
      
      // Try to parse as JSON for better error details
      try {
        const errorJson = JSON.parse(errorText);
        console.error("Parsed error:", errorJson);
        return res.status(500).json({ 
          error: "Failed to start prediction", 
          details: errorJson,
          status: replicateRes.status,
          cloudinary_url: hostedURL
        });
      } catch (e) {
        return res.status(500).json({ 
          error: "Failed to start prediction", 
          details: errorText,
          status: replicateRes.status,
          cloudinary_url: hostedURL
        });
      }
    }

    let prediction = await replicateRes.json();
    console.log("Initial prediction response:", prediction);

    // Poll for completion
    let pollCount = 0;
    const maxPolls = 60; // 2 minutes max
    
    while (prediction.status !== "succeeded" && prediction.status !== "failed" && pollCount < maxPolls) {
      pollCount++;
      console.log(`Polling attempt ${pollCount}, status: ${prediction.status}`);
      
      await new Promise((resolve) => setTimeout(resolve, 2000));
      
      const pollRes = await fetch(
        `https://api.replicate.com/v1/predictions/${prediction.id}`,
        {
          headers: {
            Authorization: `Token ${REPLICATE_API_TOKEN}`,
          },
        }
      );
      
      if (!pollRes.ok) {
        console.error("Failed to poll prediction status, response:", pollRes.status);
        break;
      }
      
      prediction = await pollRes.json();
      console.log(`Poll ${pollCount} result:`, {
        id: prediction.id,
        status: prediction.status,
        progress: prediction.progress || "no progress info"
      });
    }

    console.log("Final prediction status:", prediction.status);

    if (prediction.status === "succeeded") {
      console.log("Prediction succeeded, output:", prediction.output);
      res.json({ 
        output: prediction.output,
        cloudinary_url: hostedURL,
        id: prediction.id
      });
    } else {
      console.error("Prediction failed with final state:", prediction);
      res.status(500).json({ 
        error: "Prediction failed", 
        details: prediction,
        cloudinary_url: hostedURL
      });
    }
  } catch (err) {
    console.error("Server error:", err);
    console.error("Error stack:", err.stack);
    res.status(500).json({ 
      error: "Something went wrong", 
      details: err.message,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
});

// Test endpoint to verify Cloudinary connection
app.get("/test-cloudinary", async (req, res) => {
  try {
    const result = await cloudinary.api.ping();
    res.json({ 
      success: true, 
      cloudinary_status: "connected",
      result: result 
    });
  } catch (err) {
    res.status(500).json({ 
      success: false, 
      error: err.message,
      cloudinary_status: "failed"
    });
  }
});

// Test endpoint to verify Replicate connection
app.get("/test-replicate", async (req, res) => {
  try {
    const response = await fetch("https://api.replicate.com/v1/predictions", {
      headers: {
        Authorization: `Token ${REPLICATE_API_TOKEN}`,
      },
    });
    
    if (response.ok) {
      res.json({ 
        success: true, 
        replicate_status: "connected",
        status: response.status 
      });
    } else {
      const errorText = await response.text();
      res.status(500).json({ 
        success: false, 
        replicate_status: "failed",
        error: errorText,
        status: response.status
      });
    }
  } catch (err) {
    res.status(500).json({ 
      success: false, 
      error: err.message,
      replicate_status: "failed"
    });
  }
});

app.listen(3000, () => console.log("Server running at http://localhost:3000"));