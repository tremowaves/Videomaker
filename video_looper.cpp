#include <iostream>
#include <fstream>
#include <string>
#include <vector>
#include <cstdlib> // For system()
#include <cstdio>  // For remove()
#include <filesystem> // For path operations (C++17)
#include <sstream> // For string stream

// Function to check if a file exists
bool file_exists(const std::filesystem::path& p) {
    return std::filesystem::exists(p) && std::filesystem::is_regular_file(p);
}

// Helper function to escape paths for shell commands if needed (basic version)
std::string quote_path(const std::filesystem::path& p) {
    // On Windows, paths with spaces often need double quotes.
    // On Linux/macOS, single quotes can be more robust, or careful escaping.
    // For simplicity, using double quotes. More robust escaping might be needed for complex paths.
    return "\"" + p.string() + "\"";
}

bool create_looped_video_with_audio(
    const std::filesystem::path& input_video_path,
    const std::filesystem::path& input_audio_path,
    int num_loops,
    const std::filesystem::path& output_video_path) {

    if (!file_exists(input_video_path)) {
        std::cerr << "Error: Input video file not found at '" << input_video_path << "'" << std::endl;
        return false;
    }
    if (!file_exists(input_audio_path)) {
        std::cerr << "Error: Input audio file not found at '" << input_audio_path << "'" << std::endl;
        return false;
    }
    if (num_loops <= 0) {
        std::cerr << "Error: Number of loops must be a positive integer." << std::endl;
        return false;
    }

    std::filesystem::path temp_concat_file_path = "ffmpeg_concat_list.txt";
    std::filesystem::path temp_looped_video_path = "temp_looped_video_only.mp4";

    // 1. Create the concatenation file for FFmpeg
    std::cout << "Creating concatenation file..." << std::endl;
    { // Scope for ofstream to ensure it's closed before FFmpeg uses the file
        std::ofstream concat_file(temp_concat_file_path);
        if (!concat_file.is_open()) {
            std::cerr << "Error: Could not create temporary concat file: " << temp_concat_file_path << std::endl;
            return false;
        }
        std::filesystem::path absolute_input_video_path = std::filesystem::absolute(input_video_path);
        for (int i = 0; i < num_loops; ++i) {
            // FFmpeg concat demuxer needs 'file' directive. Paths should be escaped if they contain special characters.
            // Using absolute paths is generally safer for the concat demuxer with -safe 0.
            // The paths written to the file list itself should NOT be quoted if they don't contain problematic characters
            // for the list parser, but the input_video_path itself might need cleaning if it has single quotes.
            // For simplicity, assuming paths are well-behaved or FFmpeg's -safe 0 handles them with abspath.
            concat_file << "file '" << absolute_input_video_path.string() << "'\n";
        }
        concat_file.close();
    }
    std::cout << "Concatenation file created: " << temp_concat_file_path << std::endl;

    // 2. Loop the video using FFmpeg concat demuxer
    std::cout << "\nLooping video..." << std::endl;
    std::ostringstream ffmpeg_loop_command_ss;
    ffmpeg_loop_command_ss << "ffmpeg -y -f concat -safe 0 -i " << quote_path(temp_concat_file_path)
                           << " -an -c:v copy "
                           << quote_path(temp_looped_video_path);
    std::string ffmpeg_loop_command = ffmpeg_loop_command_ss.str();

    std::cout << "Executing: " << ffmpeg_loop_command << std::endl;
    int loop_ret_code = system(ffmpeg_loop_command.c_str());
    if (loop_ret_code != 0) {
        std::cerr << "Error: FFmpeg video looping failed with code " << loop_ret_code << std::endl;
        std::remove(temp_concat_file_path.c_str()); // Clean up
        return false;
    }
    std::cout << "Video looping successful." << std::endl;

    // 3. Combine looped video with audio
    std::cout << "\nCombining video and audio..." << std::endl;
    std::ostringstream ffmpeg_combine_command_ss;
    ffmpeg_combine_command_ss << "ffmpeg -y -i " << quote_path(temp_looped_video_path)
                              << " -i " << quote_path(std::filesystem::absolute(input_audio_path)) // Use absolute for audio too
                              << " -map 0:v:0 -map 1:a:0 -c:v copy -c:a aac -b:a 192k -shortest "
                              << quote_path(output_video_path);
    std::string ffmpeg_combine_command = ffmpeg_combine_command_ss.str();

    std::cout << "Executing: " << ffmpeg_combine_command << std::endl;
    int combine_ret_code = system(ffmpeg_combine_command.c_str());
    if (combine_ret_code != 0) {
        std::cerr << "Error: FFmpeg video/audio combining failed with code " << combine_ret_code << std::endl;
        std::remove(temp_concat_file_path.c_str());
        std::remove(temp_looped_video_path.c_str()); // Clean up
        return false;
    }
    std::cout << "Video and audio combination successful." << std::endl;

    // 4. Clean up temporary files
    std::cout << "\nCleaning up temporary files..." << std::endl;
    if (std::remove(temp_concat_file_path.c_str()) != 0) {
        std::cerr << "Warning: Could not remove temporary concat file: " << temp_concat_file_path << std::endl;
    }
    if (std::remove(temp_looped_video_path.c_str()) != 0) {
        std::cerr << "Warning: Could not remove temporary looped video file: " << temp_looped_video_path << std::endl;
    }
    std::cout << "Cleanup finished." << std::endl;

    std::cout << "\nSuccessfully created '" << output_video_path << "' with " << num_loops << " loops and selected audio." << std::endl;
    return true;
}

int main() {
    // --- Configuration ---
    std::filesystem::path input_video = "input.mp4";
    std::filesystem::path input_audio = "audio.mp3";
    int number_of_loops = 3;
    std::filesystem::path output_video = "final_looped_video_cpp.mp4";
    // --- End Configuration ---

    std::cout << "Starting video processing application..." << std::endl;
    std::cout << "Input Video: " << std::filesystem::absolute(input_video) << std::endl;
    std::cout << "Input Audio: " << std::filesystem::absolute(input_audio) << std::endl;
    std::cout << "Number of Loops: " << number_of_loops << std::endl;
    std::cout << "Output Video: " << std::filesystem::absolute(output_video) << std::endl;

    // Check if input files exist before calling the main function
    // This is also done inside the function, but good for an early exit.
    if (!file_exists(input_video)) {
        std::cerr << "Error: Main - Input video file '" << input_video
                  << "' not found. Please create it or update the path." << std::endl;
        std::cerr << "To create a dummy 1-second black video (input.mp4):" << std::endl;
        std::cerr << "ffmpeg -y -f lavfi -i color=c=black:s=1280x720:d=1 -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=44100 -c:v libx264 -c:a aac -t 1 input.mp4" << std::endl;
        return 1;
    }
    if (!file_exists(input_audio)) {
        std::cerr << "Error: Main - Input audio file '" << input_audio
                  << "' not found. Please create it or update the path." << std::endl;
        std::cerr << "To create a dummy 5-second silent audio (audio.mp3):" << std::endl;
        std::cerr << "ffmpeg -y -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=44100 -t 5 audio.mp3" << std::endl;
        return 1;
    }


    bool success = create_looped_video_with_audio(input_video, input_audio, number_of_loops, output_video);

    if (success) {
        std::cout << "\nVideo processing finished successfully." << std::endl;
    } else {
        std::cout << "\nVideo processing failed." << std::endl;
        return 1;
    }

    return 0;
}