package old_App;
import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.File;
import java.io.FileWriter;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

public class VideoLooper {

    private static void printStream(java.io.InputStream inputStream, String type) throws IOException {
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(inputStream))) {
            String line;
            System.out.println("---- " + type + " ----");
            while ((line = reader.readLine()) != null) {
                System.out.println(line);
            }
            System.out.println("---- End " + type + " ----");
        }
    }

    public static boolean createLoopedVideoWithAudio(
            String inputVideoPathStr,
            String inputAudioPathStr,
            int numLoops,
            String outputVideoPathStr) {

        Path inputVideoPath = Paths.get(inputVideoPathStr).toAbsolutePath();
        Path inputAudioPath = Paths.get(inputAudioPathStr).toAbsolutePath();
        Path outputVideoPath = Paths.get(outputVideoPathStr).toAbsolutePath();

        if (!Files.exists(inputVideoPath) || !Files.isRegularFile(inputVideoPath)) {
            System.err.println("Error: Input video file not found at '" + inputVideoPath + "'");
            return false;
        }
        if (!Files.exists(inputAudioPath) || !Files.isRegularFile(inputAudioPath)) {
            System.err.println("Error: Input audio file not found at '" + inputAudioPath + "'");
            return false;
        }
        if (numLoops <= 0) {
            System.err.println("Error: Number of loops must be a positive integer.");
            return false;
        }

        Path tempConcatFilePath = Paths.get("ffmpeg_concat_list.txt").toAbsolutePath();
        Path tempLoopedVideoPath = Paths.get("temp_looped_video_only.mp4").toAbsolutePath();

        try {
            // 1. Create the concatenation file
            System.out.println("Creating concatenation file: " + tempConcatFilePath);
            int linesWritten = 0;
            try (BufferedWriter writer = new BufferedWriter(new FileWriter(tempConcatFilePath.toFile()))) {
                for (int i = 0; i < numLoops; ++i) {
                    // FFmpeg concat demuxer needs 'file' directive.
                    // Paths with spaces or special chars must be escaped or quoted.
                    // Using .toString() and hoping ffmpeg -safe 0 handles it.
                    // For extreme paths, more robust escaping might be needed.
                    writer.write("file '" + inputVideoPath.toString().replace("\\", "/") + "'\n");
                    linesWritten++;
                }
            }
            System.out.println("Concatenation file created with " + linesWritten + " lines.");
            
            // Verify the number of lines in the concat file
            long actualLines = Files.lines(tempConcatFilePath).count();
            if (actualLines != numLoops) {
                System.err.println("Warning: Expected " + numLoops + " lines in concat file, but found " + actualLines + " lines.");
            }

            // 2. Loop the video using FFmpeg concat demuxer
            System.out.println("\nLooping video...");
            List<String> loopCommand = new ArrayList<>();
            loopCommand.add("ffmpeg");
            loopCommand.add("-y"); // Overwrite output files without asking
            loopCommand.add("-f");
            loopCommand.add("concat");
            loopCommand.add("-safe");
            loopCommand.add("0");
            loopCommand.add("-i");
            loopCommand.add(tempConcatFilePath.toString());
            loopCommand.add("-an"); // No audio
            loopCommand.add("-c:v");
            loopCommand.add("copy");
            loopCommand.add(tempLoopedVideoPath.toString());

            System.out.println("Executing: " + String.join(" ", loopCommand));
            ProcessBuilder loopProcessBuilder = new ProcessBuilder(loopCommand);
            loopProcessBuilder.redirectErrorStream(true); // Merge stdout and stderr
            Process loopProcess = loopProcessBuilder.start();
            printStream(loopProcess.getInputStream(), "FFMPEG LOOP");
            boolean loopSuccess = loopProcess.waitFor(5, TimeUnit.MINUTES); // Wait up to 5 minutes

            if (!loopSuccess || loopProcess.exitValue() != 0) {
                System.err.println("Error: FFmpeg video looping failed. Exit code: " + loopProcess.exitValue());
                return false;
            }
            System.out.println("Video looping successful.");

            // 3. Combine looped video with audio
            System.out.println("\nCombining video and audio...");
            List<String> combineCommand = new ArrayList<>();
            combineCommand.add("ffmpeg");
            combineCommand.add("-y");
            combineCommand.add("-i");
            combineCommand.add(tempLoopedVideoPath.toString());
            combineCommand.add("-i");
            combineCommand.add(inputAudioPath.toString());
            combineCommand.add("-map");
            combineCommand.add("0:v:0");
            combineCommand.add("-map");
            combineCommand.add("1:a:0");
            combineCommand.add("-c:v");
            combineCommand.add("copy");
            combineCommand.add("-c:a");
            combineCommand.add("aac");
            combineCommand.add("-b:a");
            combineCommand.add("192k");
            combineCommand.add("-shortest");
            combineCommand.add(outputVideoPath.toString());

            System.out.println("Executing: " + String.join(" ", combineCommand));
            ProcessBuilder combineProcessBuilder = new ProcessBuilder(combineCommand);
            combineProcessBuilder.redirectErrorStream(true);
            Process combineProcess = combineProcessBuilder.start();
            printStream(combineProcess.getInputStream(), "FFMPEG COMBINE");
            boolean combineSuccess = combineProcess.waitFor(5, TimeUnit.MINUTES);

            if (!combineSuccess || combineProcess.exitValue() != 0) {
                System.err.println("Error: FFmpeg video/audio combining failed. Exit code: " + combineProcess.exitValue());
                return false;
            }
            System.out.println("Video and audio combination successful.");
            System.out.println("\nSuccessfully created '" + outputVideoPath + "' with " + numLoops + " loops and selected audio.");
            return true;

        } catch (IOException e) {
            System.err.println("IOException occurred: " + e.getMessage());
            e.printStackTrace();
            return false;
        } catch (InterruptedException e) {
            System.err.println("Process was interrupted: " + e.getMessage());
            e.printStackTrace();
            Thread.currentThread().interrupt(); // set interrupt flag
            return false;
        } finally {
            // 4. Clean up temporary files
            System.out.println("\nCleaning up temporary files...");
            try {
                Files.deleteIfExists(tempConcatFilePath);
                System.out.println("Deleted: " + tempConcatFilePath);
            } catch (IOException e) {
                System.err.println("Warning: Could not remove temporary concat file: " + tempConcatFilePath);
            }
            try {
                Files.deleteIfExists(tempLoopedVideoPath);
                System.out.println("Deleted: " + tempLoopedVideoPath);
            } catch (IOException e) {
                System.err.println("Warning: Could not remove temporary looped video file: " + tempLoopedVideoPath);
            }
            System.out.println("Cleanup finished.");
        }
    }

    public static void main(String[] args) {
        // --- Configuration ---
        String inputVideo = "input.mp4";
        String inputAudio = "audio.mp3";
        int numberOfLoops = 3; // Default value
        
        // Parse command line arguments
        if (args.length > 0) {
            try {
                numberOfLoops = Integer.parseInt(args[0]);
                if (numberOfLoops <= 0) {
                    System.err.println("Error: Number of loops must be positive. Using default value of 3.");
                    numberOfLoops = 3;
                }
            } catch (NumberFormatException e) {
                System.err.println("Error: Invalid number format. Using default value of 3.");
            }
        }
        
        String outputVideo = "final_looped_video_java.mp4";
        // --- End Configuration ---

        System.out.println("Starting video processing application (Java)...");
        System.out.println("Input Video: " + Paths.get(inputVideo).toAbsolutePath());
        System.out.println("Input Audio: " + Paths.get(inputAudio).toAbsolutePath());
        System.out.println("Number of Loops: " + numberOfLoops);
        System.out.println("Output Video: " + Paths.get(outputVideo).toAbsolutePath());
        
        // Calculate expected duration
        try {
            ProcessBuilder durationProcessBuilder = new ProcessBuilder(
                "ffprobe", 
                "-v", "error", 
                "-show_entries", "format=duration", 
                "-of", "default=noprint_wrappers=1:nokey=1", 
                inputVideo
            );
            Process durationProcess = durationProcessBuilder.start();
            BufferedReader reader = new BufferedReader(new InputStreamReader(durationProcess.getInputStream()));
            String durationStr = reader.readLine();
            if (durationStr != null) {
                double duration = Double.parseDouble(durationStr);
                double expectedDuration = duration * numberOfLoops;
                int hours = (int) (expectedDuration / 3600);
                int minutes = (int) ((expectedDuration % 3600) / 60);
                int seconds = (int) (expectedDuration % 60);
                System.out.println("Expected output video duration: " + hours + "h " + minutes + "m " + seconds + "s");
            }
        } catch (Exception e) {
            System.err.println("Warning: Could not determine input video duration: " + e.getMessage());
        }

        // Simple check, user should ensure files exist or provide full paths
        if (!new File(inputVideo).exists()) {
            System.err.println("Error: Main - Input video file '" + inputVideo + "' not found. Please create it or update the path.");
             System.err.println("To create a dummy 1-second black video (input.mp4):");
             System.err.println("ffmpeg -y -f lavfi -i color=c=black:s=1280x720:d=1 -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=44100 -c:v libx264 -c:a aac -t 1 input.mp4");
            return;
        }
        if (!new File(inputAudio).exists()) {
            System.err.println("Error: Main - Input audio file '" + inputAudio + "' not found. Please create it or update the path.");
            System.err.println("To create a dummy 5-second silent audio (audio.mp3):");
            System.err.println("ffmpeg -y -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=44100 -t 5 audio.mp3");
            return;
        }

        boolean success = createLoopedVideoWithAudio(inputVideo, inputAudio, numberOfLoops, outputVideo);

        if (success) {
            System.out.println("\nVideo processing finished successfully.");
        } else {
            System.out.println("\nVideo processing failed.");
        }
    }
}