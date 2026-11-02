# fm-roles

The fifteen melodic roles (`piano` `organ` `guitar` … `synth-bass`) as FM voices,
each the `gm` voice of that instrument under the role's name.

A role with no set behind it is the machine's own: the ROM voice on the MSX's
FM-PAC, and elsewhere that ROM voice read as 4-op, a thin stand-in. Import this
on a 4-op machine and the same names are voices made for it. A new score there
does; as with a drum kit, the score keeps its names when the import changes.

```lisp
(import "presets/fm-roles/set.mmlisp")
(fm1 synth :len 4 c e g > c)
```

The set is written by `tools/scripts/gen-fm-roles.mjs`, from `presets/gm`; to
give a role another voice, change its line there.
