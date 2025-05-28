// server.js
const fs = require('fs').promises;
const fssync = require('fs'); // For synchronous checks where needed
const path = require('path');
const { spawn } = require('child_process'); // Using spawn for command execution
const express = require('express');
const multer = require('multer');

const app = express();
const port = process.env.PORT || 3000;

// --- Configuration ---
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const OUTPUT_DIR = path.join(__dirname, 'public', 'processed'); // Processed files served from public/processed
const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB
const ALLOWED_VIDEO_TYPES = ['video/mp4'];
const ALLOWED_AUDIO_TYPES = ['audio/mpeg', 'audio/wav', 'audio/mp3']; // Added 'audio/mp3'
// --- End Configuration ---

// Ensure upload and output directories exist
async function setupDirectories() {
    try {
        await fs.mkdir(UPLOAD_DIR, { recursive: true });
        console.log(`Upload directory created/exists: ${UPLOAD_DIR}`);
        await fs.mkdir(OUTPUT_DIR, { recursive: true });
        console.log(`Output directory created/exists: ${OUTPUT_DIR}`);
    } catch (error) {
        console.error("Error creating directories:", error);
        process.exit(1); // Exit if essential directories can't be created
    }
}

// Multer setup for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, UPLOAD_DIR);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        // Sanitize filename to prevent path issues
        cb(null, uniqueSuffix + '-' + file.originalname.replace(/[^a-zA-Z0-9.-_]/g, '_'));
    }
});

const fileFilter = (req, file, cb) => {
    if (file.fieldname === 'videoFile') {
        if (!ALLOWED_VIDEO_TYPES.includes(file.mimetype)) {
            return cb(new Error('Only MP4 video files are allowed!'), false);
        }
    } else if (file.fieldname === 'audioFile') {
        if (!ALLOWED_AUDIO_TYPES.includes(file.mimetype)) {
            return cb(new Error('Only MP3 and WAV audio files are allowed!'), false);
        }
    }
    cb(null, true); // Accept file
};

const upload = multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: {
        fileSize: MAX_FILE_SIZE
    }
});

// Serve static files from 'public' directory (e.g., if you add CSS or client-side JS)
app.use(express.static(path.join(__dirname, 'public')));
// Serve processed videos from 'public/processed' under the '/processed' URL path
app.use('/processed', express.static(OUTPUT_DIR));

// Centralized error handling middleware for Multer and other errors
app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({
                success: false,
                message: `File size too large. Maximum is ${MAX_FILE_SIZE / (1024 * 1024)}MB.`
            });
        }
        return res.status(400).json({
            success: false,
            message: `File upload error: ${err.message}`
        });
    } else if (err) { // Handle other errors passed to next(err)
        console.error("An unhandled error occurred:", err.stack);
        return res.status(500).json({
            success: false,
            message: 'Something went wrong on the server!'
        });
    }
    next(); // If no error or not handled here, proceed
});

// Helper to run shell commands (ffmpeg, ffprobe) using spawn
function executeCommand(command, args = []) {
    return new Promise((resolve, reject) => {
        // Create a display string for logging, quoting args with spaces for readability
        const commandDisplayArgs = args.map(arg => arg.includes(' ') ? `"${arg}"` : arg);
        const fullCommandDisplay = `${command} ${commandDisplayArgs.join(' ')}`;
        console.log(`Executing: ${fullCommandDisplay}`);
        
        const childProcess = spawn(command, args, {
            windowsHide: true // Prevents a console window from popping up on Windows
            // shell: false is default, safer, and handles spaces in args correctly if args are separate array elements.
        });
        
        let stdout = '';
        let stderr = '';

        childProcess.stdout.on('data', (data) => {
            stdout += data.toString();
        });
        childProcess.stderr.on('data', (data) => {
            stderr += data.toString();
            // FFmpeg often outputs progress info to stderr.
            // Avoid verbose logging here; full stderr will be logged on error.
        });
        childProcess.on('close', (code) => {
            if (code === 0) {
                resolve({ stdout, stderr });
            } else {
                console.error(`Command failed with code ${code}: ${fullCommandDisplay}`);
                console.error('FFMPEG/FFPROBE Stderr:\n', stderr); // Log full stderr on error
                if (stdout) console.log('FFMPEG/FFPROBE Stdout:\n', stdout); // Log stdout on error too
                
                const error = new Error(`Command "${command}" failed with code ${code}.`);
                error.stdout = stdout;
                error.stderr = stderr; // Attach stderr to the error object for upstream use
                error.code = code; // Attach exit code
                reject(error);
            }
        });
        childProcess.on('error', (err) => { // For errors like 'ffmpeg not found' (ENOENT)
            console.error(`Failed to start subprocess for command "${command}":`, err);
            reject(new Error(`Failed to start subprocess for "${command}": ${err.message}. Ensure FFmpeg/ffprobe is installed and in your system's PATH.`));
        });
    });
}

// Helper to get video duration using ffprobe
async function getVideoDuration(filePath) {
    const command = 'ffprobe';
    const args = [
        '-v', 'error', // Suppress informational messages, only print errors
        '-show_entries', 'format=duration', // Get duration
        '-of', 'default=noprint_wrappers=1:nokey=1', // Output format: just the duration value
        filePath // The path to the video file
    ];
    
    try {
        console.log(`Probing duration for video: ${filePath}`);
        const { stdout, stderr } = await executeCommand(command, args);
        
        // ffprobe might output to stderr even on success (e.g., warnings)
        // If stdout (duration) is empty but stderr has content, it might indicate an issue.
        if (stderr && stderr.trim() !== '' && !stdout.trim()) {
            console.warn(`ffprobe for ${filePath} produced stderr without stdout duration: ${stderr.trim()}`);
        }
        
        const duration = parseFloat(stdout.trim());

        if (isNaN(duration) || duration <= 0) {
            const errorMessage = `Could not parse a valid, positive video duration from ffprobe output for ${filePath}. stdout: "${stdout.trim()}", stderr: "${stderr.trim()}"`;
            console.error(errorMessage);
            // Create an error object that can be caught by the calling function
            const durationError = new Error(errorMessage);
            durationError.ffmpegStdout = stdout;
            durationError.ffmpegStderr = stderr;
            throw durationError;
        }
        return duration;
    } catch (error) {
        // Error could be from executeCommand (e.g., ffprobe not found, or ffprobe exited with error code)
        // or from parsing the duration.
        console.error(`Error in getVideoDuration for "${filePath}": ${error.message}`);
        // Re-throw an enriched error or the original error to be handled by the caller
        const specificError = new Error(`Failed to get video duration for "${filePath}". ${error.message}`);
        specificError.originalError = error; // Nest original error
        specificError.ffmpegStderr = error.stderr || (error.originalError && error.originalError.stderr);
        specificError.ffmpegStdout = error.stdout || (error.originalError && error.originalError.stdout);
        throw specificError;
    }
}

// Core video processing logic
async function createLoopedVideoWithAudio(inputVideoPath, inputAudioPath, numLoops, outputFileName, fullHD = false) {
    const absInputVideoPath = path.resolve(inputVideoPath);
    const absInputAudioPath = path.resolve(inputAudioPath);
    const absOutputVideoPath = path.resolve(OUTPUT_DIR, outputFileName);

    // Validate file existence (though multer handles initial upload)
    try {
        await fs.access(absInputVideoPath);
    } catch (e) {
        throw new Error(`Input video file not found at '${absInputVideoPath}' (post-upload check)`);
    }
    try {
        await fs.access(absInputAudioPath);
    } catch (e) {
        throw new Error(`Input audio file not found at '${absInputAudioPath}' (post-upload check)`);
    }

    if (numLoops <= 0) { // Should be caught by client/route handler, but defensive check
        throw new Error("Number of loops must be a positive integer.");
    }

    const tempConcatFilePath = path.resolve(UPLOAD_DIR, `ffmpeg_concat_${Date.now()}.txt`);
    const tempLoopedVideoPath = path.resolve(UPLOAD_DIR, `temp_looped_video_only_${Date.now()}.mp4`);
    let inputVideoDuration;

    try {
        inputVideoDuration = await getVideoDuration(absInputVideoPath);
        // getVideoDuration already throws if duration is invalid or zero
        console.log(`Input video duration: ${inputVideoDuration} seconds.`);
        const totalLoopedVideoDuration = inputVideoDuration * numLoops;
        console.log(`Target total video duration for looped video: ${totalLoopedVideoDuration.toFixed(3)} seconds.`);

        // 1. Create the FFmpeg concatenation file
        console.log(`Creating concatenation file: ${tempConcatFilePath}`);
        let concatFileContent = "";
        // FFmpeg concat demuxer needs forward slashes in paths.
        // Paths in concat file should be quoted if they contain special characters (like spaces).
        // Using absolute paths for robustness.
        const videoPathForConcat = absInputVideoPath.replace(/\\/g, '/');
        for (let i = 0; i < numLoops; ++i) {
            // The single quotes are for the concat demuxer's 'file' directive.
            concatFileContent += `file '${videoPathForConcat}'\n`;
        }
        await fs.writeFile(tempConcatFilePath, concatFileContent);
        console.log("Concatenation file created.");

        // 2. Loop the video (without its original audio)
        console.log("\nLooping video (video stream only)...");
        const loopArgs = [
            '-y', // Overwrite output files without asking
            '-f', 'concat',
            '-safe', '0', // Allow "unsafe" file paths (e.g., absolute paths or outside CWD)
            '-i', tempConcatFilePath,
            '-an', // No audio in this intermediate step
            '-c:v', 'copy', // Copy video stream without re-encoding (fast)
            tempLoopedVideoPath // Output to a temporary file
        ];
        await executeCommand('ffmpeg', loopArgs);
        console.log("Video looping successful.");

        // 3. Combine the looped video with the new audio, trimming to total video duration
        console.log("\nCombining looped video with audio...");
        const combineArgs = [
            '-y',
            '-i', tempLoopedVideoPath,      // Input 1: Looped video (absolute path)
            '-stream_loop', '-1',         // Loop the *next* input stream (audio) indefinitely
            '-i', absInputAudioPath,        // Input 2: Audio file (absolute path)
            '-map', '0:v:0',              // Map video from input 0 (looped video)
            '-map', '1:a:0',              // Map audio from input 1 (new audio)
            '-c:v', fullHD ? 'libx264' : 'copy',  // Re-encode if Full HD is requested
            ...(fullHD ? [
                '-vf', 'scale=1920:1080',  // Scale to Full HD
                '-preset', 'medium',       // Encoding preset (balance between speed and quality)
                '-crf', '23'              // Constant Rate Factor (lower = better quality, 23 is default)
            ] : []),
            '-c:a', 'aac',                // Re-encode audio to AAC (common, compatible format)
            '-b:a', '192k',               // Audio bitrate
            '-t', totalLoopedVideoDuration.toFixed(3).toString(), // Set total output duration to match looped video
            absOutputVideoPath            // Final output file (absolute path)
        ];
        await executeCommand('ffmpeg', combineArgs);
        console.log("Video and audio combination successful.");

        console.log(`\nSuccessfully created '${absOutputVideoPath}' with ${numLoops} loops and selected audio.`);
        return { success: true, outputPath: absOutputVideoPath, outputFileName: outputFileName };

    } catch (error) {
        // Enrich error with FFmpeg details if available
        const processingError = new Error(`Video processing failed: ${error.message}`);
        if (error.ffmpegStderr) processingError.ffmpegStderr = error.ffmpegStderr;
        else if (error.originalError && error.originalError.stderr) processingError.ffmpegStderr = error.originalError.stderr;
        
        if (error.ffmpegStdout) processingError.ffmpegStdout = error.ffmpegStdout;
        else if (error.originalError && error.originalError.stdout) processingError.ffmpegStdout = error.originalError.stdout;

        console.error("Detailed error during video processing:", processingError.message);
        if(processingError.ffmpegStderr) console.error("FFMPEG Stderr (from processing):", processingError.ffmpegStderr);

        throw processingError; // Re-throw the enriched error
    } finally {
        // 4. Clean up temporary files
        console.log("\nCleaning up temporary files...");
        for (const tempFile of [tempConcatFilePath, tempLoopedVideoPath]) {
            try {
                // Check existence before unlinking to avoid errors if creation failed early
                if (fssync.existsSync(tempFile)) { 
                    await fs.unlink(tempFile);
                    console.log(`Deleted temporary file: ${tempFile}`);
                }
            } catch (e) {
                console.warn(`Warning: Could not remove temporary file: ${tempFile} (${e.message})`);
            }
        }
        console.log("Temporary files cleanup finished.");
    }
}

// Endpoint for processing video
app.post('/process-video', upload.fields([
    { name: 'videoFile', maxCount: 1 },
    { name: 'audioFile', maxCount: 1 }
]), async (req, res) => {
    console.log('Received request to /process-video');
    
    // Ensure files are uploaded
    if (!req.files || !req.files.videoFile || !req.files.videoFile[0] || !req.files.audioFile || !req.files.audioFile[0]) {
        // Clean up any partially uploaded files if validation fails here
        if (req.files) {
            if (req.files.videoFile && req.files.videoFile[0] && fssync.existsSync(req.files.videoFile[0].path)) await fs.unlink(req.files.videoFile[0].path).catch(e => console.warn("Cleanup failed for partial video upload on missing files error"));
            if (req.files.audioFile && req.files.audioFile[0] && fssync.existsSync(req.files.audioFile[0].path)) await fs.unlink(req.files.audioFile[0].path).catch(e => console.warn("Cleanup failed for partial audio upload on missing files error"));
        }
        return res.status(400).json({
            success: false,
            message: 'Both video and audio files are required.'
        });
    }

    const videoFile = req.files.videoFile[0];
    const audioFile = req.files.audioFile[0];

    // Validate numLoops
    const numLoops = parseInt(req.body.numLoops);
    if (isNaN(numLoops) || numLoops < 1 || numLoops > 1000) {
        // Clean up uploaded files if numLoops is invalid
        if (fssync.existsSync(videoFile.path)) await fs.unlink(videoFile.path).catch(e => console.warn("Cleanup failed for video upload on invalid loops"));
        if (fssync.existsSync(audioFile.path)) await fs.unlink(audioFile.path).catch(e => console.warn("Cleanup failed for audio upload on invalid loops"));
        return res.status(400).json({
            success: false,
            message: 'Number of loops must be an integer between 1 and 1000.'
        });
    }

    // Get Full HD option
    const fullHD = req.body.fullHD === 'true';

    // Sanitize original video name for use in output filename
    const originalVideoNameSanitized = path.parse(videoFile.originalname).name.replace(/[^a-zA-Z0-9_.-]/g, '_');
    const outputFileName = `looped_${originalVideoNameSanitized}_${Date.now()}.mp4`;

    try {
        const result = await createLoopedVideoWithAudio(
            videoFile.path, // Path to uploaded video in UPLOAD_DIR
            audioFile.path, // Path to uploaded audio in UPLOAD_DIR
            numLoops,
            outputFileName,
            fullHD // Pass the Full HD option
        );

        res.json({
            success: true,
            message: 'Video processed successfully!',
            downloadUrl: `/processed/${outputFileName}`, // URL to download the processed file
            outputFileName: outputFileName
        });
    } catch (error) {
        console.error("Error in /process-video endpoint handling:", error.message);
        let clientErrorMessage = error.message || 'An error occurred during video processing.';
        // Append FFmpeg specific error details for client, if available
        if (error.ffmpegStderr) {
            // Sanitize and shorten FFmpeg error for client message; full log is on server
            const cleanStderr = String(error.ffmpegStderr).replace(/\r\n|\r|\n/g, ' ').substring(0, 300);
            clientErrorMessage += ` (Details: ${cleanStderr}${error.ffmpegStderr.length > 300 ? '...' : ''})`;
        }
        
        res.status(500).json({
            success: false,
            message: clientErrorMessage
        });
    } finally {
        // Clean up original uploaded files from UPLOAD_DIR after processing is complete or failed
        try {
            if (fssync.existsSync(videoFile.path)) await fs.unlink(videoFile.path);
            if (fssync.existsSync(audioFile.path)) await fs.unlink(audioFile.path);
        } catch (e) {
            console.warn('Warning: Could not delete one or more uploaded files post-processing:', e.message);
        }
    }
});

// Serve index.html from the project root
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Initialize directories and start the server
(async () => {
    await setupDirectories();
    app.listen(port, () => {
        console.log(`Server listening at http://localhost:${port}`);
        console.log(`Ensure FFmpeg and ffprobe are installed and in your system's PATH.`);
        console.log(`Uploads temporarily in: ${UPLOAD_DIR}`);
        console.log(`Processed videos in: ${OUTPUT_DIR} (served via /processed)`);
    });
})();