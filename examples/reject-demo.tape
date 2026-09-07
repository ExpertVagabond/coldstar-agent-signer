# Renders examples/reject-demo.mjs to video. Run from the repo root:
#
#   vhs examples/reject-demo.tape
#
# Requires vhs, ttyd, and ffmpeg. The pace is set here rather than in the script
# so the demo stays fast to run and slow enough to read.

Output examples/out/reject-demo.mp4
Output examples/out/reject-demo.gif

Set Shell "bash"
Set FontSize 22
Set Width 1500
Set Height 900
Set Theme "TokyoNight"
Set Padding 40
Set TypingSpeed 45ms
Set PlaybackSpeed 1.0

Hide
Type "clear"
Enter
Show

Sleep 1s
Type "DEMO_PACE=2500 node examples/reject-demo.mjs"
Sleep 700ms
Enter

Sleep 26s
Sleep 3s
