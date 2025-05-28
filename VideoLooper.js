const fs = require('fs').promises; // For async file operations
const path = require('path');
const { exec } = require('child_process'); // Can use spawn for better stream handling if needed

// Helper to run shell commands and return a Promise
function executeCommand(command) {
    return new Promise((resolve, reject) => {
        console.log(`Executing: ${command}`);
        const process = exec(command, (error, stdout, stderr) => {
            if (stdout) console.log('Stdout:\n', stdout);
            if (stderr) console.error('Stderr:\n', stderr);
            if (error) {
                console.error(`Execution error for command "${command}":`, error);
                reject(error);
                return;
            }
            resolve({ stdout, stderr });
        });
    });
}

async function createLoopedVideoWithAudio(inputVideoPath, inputAudioPath, numLoops, outputVideoPath) {
    const absInputVideoPath = path.resolve(inputVideoPath);
    const absInputAudioPath = path.resolve(inputAudioPath);
    const absOutputVideoPath = path.resolve(outputVideoPath);

    try {
        await fs.access(absInputVideoPath); // Check if input video exists
    } catch (e) {
        console.error(`Error: Input video file not found at '${absInputVideoPath}'`);
        return false;
    }
    try {
        await fs.access(absInputAudioPath); // Check if input audio exists
    } catch (e) {
        console.error(`Error: Input audio file not found at '${absInputAudioPath}'`);
        return false;
    }

    if (numLoops <= 0) {
        console.error("Error: Number of loops must be a positive integer.");
        return false;
    }

    const tempConcatFilePath = path.resolve("ffmpeg_concat_list.txt");
    const tempLoopedVideoPath = path.resolve("temp_looped_video_only.mp4");

    try {
        // 1. Create the concatenation file
        console.log(`Creating concatenation file: ${tempConcatFilePath}`);
        let concatFileContent = "";
        for (let i = 0; i < numLoops; ++i) {
            // FFmpeg concat demuxer needs 'file' directive.
            // For paths with spaces, they should be quoted *within the file list entry*.
            // The path.resolve should give an absolute path, which helps.
            // Replacing backslashes for Windows paths used in ffmpeg file lists.
            const sanitizedPath = absInputVideoPath.replace(/\\/g, '/');
            concatFileContent += `file '${sanitizedPath}'\n`;
        }
        await fs.writeFile(tempConcatFilePath, concatFileContent);
        console.log("Concatenation file created.");

        // 2. Loop the video (no audio)
        console.log("\nLooping video...");
        // Quote paths for the shell command itself
        const loopCommand = `ffmpeg -y -f concat -safe 0 -i "${tempConcatFilePath}" -an -c:v copy "${tempLoopedVideoPath}"`;
        await executeCommand(loopCommand);
        console.log("Video looping successful.");

        // 3. Combine looped video with audio
        console.log("\nCombining video and audio...");
        const combineCommand = `ffmpeg -y -i "${tempLoopedVideoPath}" -i "${absInputAudioPath}" -map 0:v:0 -map 1:a:0 -c:v copy -c:a aac -b:a 192k -shortest "${absOutputVideoPath}"`;
        await executeCommand(combineCommand);
        console.log("Video and audio combination successful.");

        console.log(`\nSuccessfully created '${absOutputVideoPath}' with ${numLoops} loops and selected audio.`);
        return true;

    } catch (error) {
        console.error("An error occurred during video processing:", error.message || error);
        if(error.stderr) console.error("FFMPEG Stderr:", error.stderr);
        if(error.stdout) console.log("FFMPEG Stdout:", error.stdout);
        return false;
    } finally {
        // 4. Clean up temporary files
        console.log("\nCleaning up temporary files...");
        try {
            await fs.unlink(tempConcatFilePath);
            console.log(`Deleted: ${tempConcatFilePath}`);
        } catch (e) {
            console.warn(`Warning: Could not remove temporary concat file: ${tempConcatFilePath} (${e.message})`);
        }
        try {
            await fs.unlink(tempLoopedVideoPath);
            console.log(`Deleted: ${tempLoopedVideoPath}`);
        } catch (e) {
            console.warn(`Warning: Could not remove temporary looped video file: ${tempLoopedVideoPath} (${e.message})`);
        }
        console.log("Cleanup finished.");
    }
}

// --- Main execution ---
(async () => {
    // --- Configuration ---
    const inputVideo = "input.mp4";
    const inputAudio = "audio.mp3";
    const numberOfLoops = 225;
    const outputVideo = "final_looped_video_js.mp4";
    // --- End Configuration ---

    console.log("Starting video processing application (Node.js)...");
    console.log(`Input Video: ${path.resolve(inputVideo)}`);
    console.log(`Input Audio: ${path.resolve(inputAudio)}`);
    console.log(`Number of Loops: ${numberOfLoops}`);
    console.log(`Output Video: ${path.resolve(outputVideo)}`);

    try {
        await fs.access(inputVideo);
    } catch (e) {
        console.error(`Error: Main - Input video file '${inputVideo}' not found. Please create it or update the path.`);
        console.error("To create a dummy 1-second black video (input.mp4):");
        console.error("ffmpeg -y -f lavfi -i color=c=black:s=1280x720:d=1 -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=44100 -c:v libx264 -c:a aac -t 1 input.mp4");
        return;
    }
     try {
        await fs.access(inputAudio);
    } catch (e) {
        console.error(`Error: Main - Input audio file '${inputAudio}' not found. Please create it or update the path.`);
        console.error("To create a dummy 5-second silent audio (audio.mp3):");
        console.error("ffmpeg -y -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=44100 -t 5 audio.mp3");
        return;
    }


    const success = await createLoopedVideoWithAudio(inputVideo, inputAudio, numberOfLoops, outputVideo);

    if (success) {
        console.log("\nVideo processing finished successfully.");
    } else {
        console.log("\nVideo processing failed.");
    }
})();