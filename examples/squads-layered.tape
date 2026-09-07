# Renders examples/squads-layered.mjs to video. Run from the repo root:
#
#   vhs examples/squads-layered.tape
#
# stderr is dropped because a transitive dependency prints a harmless
# "bigint: Failed to load bindings" warning that is not part of the demo.

Output examples/out/squads-layered.mp4
Output examples/out/squads-layered.gif

Set Shell "bash"
Set FontSize 20
Set Width 1600
Set Height 940
Set Theme "TokyoNight"
Set Padding 40
Set TypingSpeed 45ms

Hide
Type "clear"
Enter
Show

Sleep 1s
Type "DEMO_PACE=2400 node examples/squads-layered.mjs 2>/dev/null"
Sleep 700ms
Enter

Sleep 26s
Sleep 3s
