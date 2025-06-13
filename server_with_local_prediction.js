const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { spawn } = require('child_process');
const cloudinary = require('cloudinary').v2;
require("dotenv").config();

const app = express();
const upload = multer({ dest: "uploads/" });

// Configure Cloudinary (optional - for hosting results)
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

app.use(express.static("public"));

// Function to detect available Python command
function detectPythonCommand() {
  return new Promise((resolve, reject) => {
    const commands = ['py', 'python'];
    
    const testCommand = (cmd, index) => {
      if (index >= commands.length) {
        reject(new Error('No Python installation found. Please install Python from python.org'));
        return;
      }
      
      const testProcess = spawn(cmd, ['--version'], { stdio: 'pipe' });
      
      testProcess.on('close', (code) => {
        if (code === 0) {
          console.log(`Found Python command: ${cmd}`);
          resolve(cmd);
        } else {
          testCommand(commands[index + 1], index + 1);
        }
      });
      
      testProcess.on('error', () => {
        testCommand(commands[index + 1], index + 1);
      });
    };
    
    testCommand(commands[0], 0);
  });
}

// Function to run local Python predictor
async function runLocalPredictor(prompt, imagePath = null) {
  return new Promise(async (resolve, reject) => {
    try {
      // Detect Python command
      const pythonCmd = await detectPythonCommand();
      
      const outputPath = `outputs/texture_${Date.now()}.png`;
      
      // Ensure output directory exists
      if (!fs.existsSync('outputs')) {
        fs.mkdirSync('outputs');
      }
      
      const args = [
        'standalone_predictor.py',
        '--prompt', prompt,
        '--output', outputPath,
        '--json-output'
      ];
      
      if (imagePath) {
        args.push('--image', imagePath);
      }
      
      console.log('Running:', pythonCmd, args.join(' '));
      
      const pythonProcess = spawn(pythonCmd, args);
    
    let stdout = '';
    let stderr = '';
    
    pythonProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    
    pythonProcess.stderr.on('data', (data) => {
      stderr += data.toString();
      console.log('Python stderr:', data.toString());
    });
    
    pythonProcess.on('close', (code) => {
      if (code === 0) {
        try {
          const result = JSON.parse(stdout.trim());
          resolve(result);
        } catch (e) {
          resolve({ success: true, output_path: outputPath });
        }
      } else {
        reject(new Error(`Python process failed with code ${code}: ${stderr}`));
      }
    });
    
    pythonProcess.on('error', (error) => {
      reject(new Error(`Failed to start Python process: ${error.message}. Make sure Python is installed and added to PATH.`));
    });
  } catch (error) {
    reject(error);
  }
});
}

app.post("/generate-texture", upload.single("image"), async (req, res) => {
  try {
    console.log("=== Starting LOCAL texture generation ===");
    
    const prompt = req.body.prompt || "tileable fabric pattern";
    let imagePath = null;
    
    if (req.file) {
      console.log("File received:", {
        filename: req.file.filename,
        originalname: req.file.originalname,
        mimetype: req.file.mimetype,
        size: req.file.size
      });
      
      imagePath = path.join(__dirname, req.file.path);
      console.log("Image path:", imagePath);
    }
    
    console.log("Running local prediction with prompt:", prompt);
    
    // Run local Python predictor
    const result = await runLocalPredictor(prompt, imagePath);
    
    // Clean up uploaded file
    if (imagePath && fs.existsSync(imagePath)) {
      fs.unlinkSync(imagePath);
      console.log("Local uploaded file cleaned up");
    }
    
    if (result.success) {
      // Optionally upload result to Cloudinary for hosting
      let hostedUrl = null;
      if (process.env.CLOUDINARY_CLOUD_NAME) {
        try {
          const cloudinaryResult = await cloudinary.uploader.upload(result.output_path, {
            folder: 'generated-textures',
            resource_type: 'image'
          });
          hostedUrl = cloudinaryResult.secure_url;
          console.log("Result uploaded to Cloudinary:", hostedUrl);
        } catch (cloudinaryError) {
          console.log("Cloudinary upload failed (optional):", cloudinaryError.message);
        }
      }
      
      res.json({
        success: true,
        output: result.output_path,
        hosted_url: hostedUrl,
        prompt: prompt
      });
    } else {
      res.status(500).json({
        error: "Local prediction failed",
        details: result.error
      });
    }
    
  } catch (err) {
    console.error("Server error:", err);
    res.status(500).json({
      error: "Something went wrong",
      details: err.message
    });
  }
});

// Serve generated images
app.use('/outputs', express.static('outputs'));

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "Local server running" });
});

app.listen(3000, () => {
  console.log("Server running at http://localhost:3000");
  console.log("Using LOCAL Stable Diffusion predictor");
});