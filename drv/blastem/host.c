// A libretro frontend with no screen, no speaker and no interaction: load
// BlastEm's core, run a ROM for N frames, write what came out of the YM2612 to
// a .wav.
//
//   cc -O2 -o host host.c -ldl
//   ./host --core blastem_libretro.so --rom song.bin --frames 1800 --wav out.wav
//
// WHY THIS EXISTS. Until now the only way to find out what the driver does on a
// Mega Drive was to build a ROM, run it in BlastEm on a desktop, and listen.
// Every gate in this repo stayed green through three separate bugs that a
// machine found in minutes (plan-68k-split.md, 2026-08-29), and every engine
// question cost a round of somebody's attention. The emulator is the reference
// implementation of the hardware we are arguing with, and it builds as a
// libretro core with no SDL, no X11 and no audio device — so it can run here,
// in a container, from a script, and hand back a file.
//
// The core's audio is the YM2612's own rate (master/1008 = 53,267 Hz NTSC),
// stereo s16 — the sample stream the DAC actually produced, not a resampling of
// it. That is the signal the DAC-clock work is about.
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// ── The slice of libretro this needs ────────────────────────────────────────
// Declared here rather than including libretro.h, so the harness builds against
// a core it never compiled with. The ABI is the contract; these are the only
// entry points and the only environment commands that matter to a run.
#define RETRO_ENVIRONMENT_GET_OVERSCAN            2
#define RETRO_ENVIRONMENT_GET_CAN_DUPE            3
#define RETRO_ENVIRONMENT_SET_PIXEL_FORMAT       10
#define RETRO_ENVIRONMENT_SET_INPUT_DESCRIPTORS  11
#define RETRO_ENVIRONMENT_GET_VARIABLE           15
#define RETRO_ENVIRONMENT_SET_VARIABLES          16
#define RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE    17
#define RETRO_ENVIRONMENT_GET_LOG_INTERFACE      27
#define RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY    9
#define RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY     31
#define RETRO_ENVIRONMENT_SET_GEOMETRY           37
#define RETRO_ENVIRONMENT_SET_CORE_OPTIONS_V2    67

struct retro_variable { const char *key; const char *value; };
struct retro_game_info {
	const char *path; const void *data; size_t size; const char *meta;
};
struct retro_game_geometry {
	unsigned base_width, base_height, max_width, max_height; float aspect_ratio;
};
struct retro_system_timing { double fps; double sample_rate; };
struct retro_system_av_info {
	struct retro_game_geometry geometry; struct retro_system_timing timing;
};

typedef int  (*env_t)(unsigned, void *);
typedef void (*video_t)(const void *, unsigned, unsigned, size_t);
typedef void (*audio_t)(int16_t, int16_t);
typedef size_t (*audio_batch_t)(const int16_t *, size_t);
typedef void (*input_poll_t)(void);
typedef int16_t (*input_state_t)(unsigned, unsigned, unsigned, unsigned);

static struct {
	void (*set_environment)(env_t);
	void (*set_video_refresh)(video_t);
	void (*set_audio_sample)(audio_t);
	void (*set_audio_sample_batch)(audio_batch_t);
	void (*set_input_poll)(input_poll_t);
	void (*set_input_state)(input_state_t);
	void (*init)(void);
	void (*deinit)(void);
	int  (*load_game)(const struct retro_game_info *);
	void (*unload_game)(void);
	void (*get_system_av_info)(struct retro_system_av_info *);
	void (*run)(void);
	void *(*get_memory_data)(unsigned);
	size_t (*get_memory_size)(unsigned);
} core;

#define RETRO_MEMORY_SYSTEM_RAM 2

// ── Captured audio ──────────────────────────────────────────────────────────
static int16_t *pcm;
static size_t   pcm_len, pcm_cap;

static size_t on_audio_batch(const int16_t *data, size_t frames)
{
	size_t need = pcm_len + frames * 2;
	if (need > pcm_cap) {
		while (pcm_cap < need) pcm_cap = pcm_cap ? pcm_cap * 2 : (1 << 20);
		pcm = realloc(pcm, pcm_cap * sizeof(*pcm));
		if (!pcm) { fprintf(stderr, "host: out of memory for audio\n"); exit(1); }
	}
	memcpy(pcm + pcm_len, data, frames * 2 * sizeof(*data));
	pcm_len += frames * 2;
	return frames;
}

static void on_audio(int16_t l, int16_t r) { int16_t s[2] = {l, r}; on_audio_batch(s, 1); }
static void on_video(const void *d, unsigned w, unsigned h, size_t p)
{ (void)d; (void)w; (void)h; (void)p; }
static void on_input_poll(void) {}
static int16_t on_input_state(unsigned a, unsigned b, unsigned c, unsigned d)
{ (void)a; (void)b; (void)c; (void)d; return 0; }

// Core options, as key/value pairs on the command line (--opt k=v). BlastEm
// reads region and model this way, and a run that means to characterise NTSC
// hardware must not be left to the core's own default.
static struct { const char *key, *val; } opts[32];
static int n_opts;

static char sysdir[] = ".";

static void core_log(unsigned lvl, const char *fmt, ...) { (void)lvl; (void)fmt; }

static int on_env(unsigned cmd, void *data)
{
	switch (cmd) {
	case RETRO_ENVIRONMENT_GET_CAN_DUPE:
		*(char *)data = 1; return 1;
	case RETRO_ENVIRONMENT_SET_PIXEL_FORMAT:
		return 1;
	case RETRO_ENVIRONMENT_GET_OVERSCAN:
		*(char *)data = 0; return 1;
	case RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY:
	case RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY:
		*(const char **)data = sysdir; return 1;
	case RETRO_ENVIRONMENT_GET_VARIABLE: {
		struct retro_variable *var = data;
		for (int i = 0; i < n_opts; i++)
			if (!strcmp(var->key, opts[i].key)) { var->value = opts[i].val; return 1; }
		var->value = NULL;
		return 0;
	}
	case RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE:
		*(char *)data = 0; return 1;
	case RETRO_ENVIRONMENT_GET_LOG_INTERFACE:
		*(void **)data = (void *)core_log; return 1;
	// Everything else is a courtesy the core can do without: descriptors,
	// geometry changes, option declarations. Answering "unsupported" is a valid
	// frontend, and it keeps this file from tracking libretro's growth.
	default:
		return 0;
	}
}

// ── WAV out ────────────────────────────────────────────────────────────────
static void put32(FILE *f, uint32_t v) { fputc(v, f); fputc(v >> 8, f); fputc(v >> 16, f); fputc(v >> 24, f); }
static void put16(FILE *f, uint16_t v) { fputc(v, f); fputc(v >> 8, f); }

static int write_wav(const char *path, int rate)
{
	FILE *f = fopen(path, "wb");
	if (!f) { perror(path); return 0; }
	uint32_t bytes = pcm_len * sizeof(*pcm);
	fwrite("RIFF", 1, 4, f); put32(f, 36 + bytes); fwrite("WAVE", 1, 4, f);
	fwrite("fmt ", 1, 4, f); put32(f, 16); put16(f, 1); put16(f, 2);
	put32(f, rate); put32(f, rate * 4); put16(f, 4); put16(f, 16);
	fwrite("data", 1, 4, f); put32(f, bytes);
	fwrite(pcm, 1, bytes, f);
	fclose(f);
	return 1;
}

// ── main ───────────────────────────────────────────────────────────────────
static void *must_sym(void *lib, const char *name)
{
	void *s = dlsym(lib, name);
	if (!s) { fprintf(stderr, "host: core has no %s\n", name); exit(1); }
	return s;
}

int main(int argc, char **argv)
{
	const char *corepath = NULL, *rompath = NULL, *wavpath = NULL, *mboxpath = NULL;
	long frames = 600, mbox_off = -1, mbox_words = 12;
	for (int i = 1; i < argc; i++) {
		if (!strcmp(argv[i], "--core") && i + 1 < argc) corepath = argv[++i];
		else if (!strcmp(argv[i], "--rom") && i + 1 < argc) rompath = argv[++i];
		else if (!strcmp(argv[i], "--wav") && i + 1 < argc) wavpath = argv[++i];
		else if (!strcmp(argv[i], "--frames") && i + 1 < argc) frames = atol(argv[++i]);
		// Where the ROM published its counters, as a byte offset into 68000 work
		// RAM. tools/build-verify-rom.mjs reports it from the image's own symbol
		// table, so neither side carries a magic address.
		else if (!strcmp(argv[i], "--mailbox") && i + 1 < argc) mbox_off = strtol(argv[++i], NULL, 0);
		else if (!strcmp(argv[i], "--mailbox-words") && i + 1 < argc) mbox_words = atol(argv[++i]);
		else if (!strcmp(argv[i], "--mailbox-out") && i + 1 < argc) mboxpath = argv[++i];
		else if (!strcmp(argv[i], "--opt") && i + 1 < argc) {
			char *kv = argv[++i], *eq = strchr(kv, '=');
			if (!eq || n_opts >= 32) { fprintf(stderr, "host: bad --opt %s\n", kv); return 2; }
			*eq = 0;
			opts[n_opts].key = kv; opts[n_opts].val = eq + 1; n_opts++;
		} else { fprintf(stderr, "host: unknown argument %s\n", argv[i]); return 2; }
	}
	if (!corepath || !rompath) {
		fprintf(stderr, "usage: host --core <lib> --rom <file> [--frames N] [--wav out.wav] [--opt k=v]\n");
		return 2;
	}

	void *lib = dlopen(corepath, RTLD_NOW);
	if (!lib) { fprintf(stderr, "host: %s\n", dlerror()); return 1; }
	core.set_environment        = must_sym(lib, "retro_set_environment");
	core.set_video_refresh      = must_sym(lib, "retro_set_video_refresh");
	core.set_audio_sample       = must_sym(lib, "retro_set_audio_sample");
	core.set_audio_sample_batch = must_sym(lib, "retro_set_audio_sample_batch");
	core.set_input_poll         = must_sym(lib, "retro_set_input_poll");
	core.set_input_state        = must_sym(lib, "retro_set_input_state");
	core.init                   = must_sym(lib, "retro_init");
	core.deinit                 = must_sym(lib, "retro_deinit");
	core.load_game              = must_sym(lib, "retro_load_game");
	core.unload_game            = must_sym(lib, "retro_unload_game");
	core.get_system_av_info     = must_sym(lib, "retro_get_system_av_info");
	core.run                    = must_sym(lib, "retro_run");
	core.get_memory_data        = must_sym(lib, "retro_get_memory_data");
	core.get_memory_size        = must_sym(lib, "retro_get_memory_size");

	// set_environment before init: the core declares its options inside it, and
	// reads them back during load_game.
	core.set_environment(on_env);
	core.set_video_refresh(on_video);
	core.set_audio_sample(on_audio);
	core.set_audio_sample_batch(on_audio_batch);
	core.set_input_poll(on_input_poll);
	core.set_input_state(on_input_state);
	core.init();

	FILE *rf = fopen(rompath, "rb");
	if (!rf) { perror(rompath); return 1; }
	fseek(rf, 0, SEEK_END);
	long romlen = ftell(rf);
	fseek(rf, 0, SEEK_SET);
	void *rom = malloc(romlen);
	if (fread(rom, 1, romlen, rf) != (size_t)romlen) { fprintf(stderr, "host: short read\n"); return 1; }
	fclose(rf);

	struct retro_game_info info = { .path = rompath, .data = rom, .size = romlen, .meta = NULL };
	if (!core.load_game(&info)) { fprintf(stderr, "host: core refused %s\n", rompath); return 1; }

	struct retro_system_av_info av;
	core.get_system_av_info(&av);
	fprintf(stderr, "host: %ld frames at %.4f fps, audio %.0f Hz\n",
	        frames, av.timing.fps, av.timing.sample_rate);

	for (long i = 0; i < frames; i++) core.run();

	// ── The ROM's own numbers ───────────────────────────────────────────────
	// Read out of the core's work RAM, which costs the emulated machine nothing:
	// no debug port, no bus grab, no patched emulator. BlastEm stores work RAM as
	// host-order 16-bit words, so a u16 field reads back as one word and the
	// mailbox is deliberately all u16 (verify-rom/probe.h).
	if (mbox_off >= 0) {
		uint16_t *ram = core.get_memory_data(RETRO_MEMORY_SYSTEM_RAM);
		size_t ramsz = core.get_memory_size(RETRO_MEMORY_SYSTEM_RAM);
		if (!ram || (size_t)mbox_off + mbox_words * 2 > ramsz) {
			fprintf(stderr, "host: work RAM unavailable or mailbox out of range\n");
			return 1;
		}
		FILE *mf = mboxpath ? fopen(mboxpath, "w") : stdout;
		if (!mf) { perror(mboxpath); return 1; }
		fprintf(mf, "[");
		for (long i = 0; i < mbox_words; i++)
			fprintf(mf, "%s%u", i ? "," : "", ram[mbox_off / 2 + i]);
		fprintf(mf, "]\n");
		if (mboxpath) fclose(mf);
	}

	if (wavpath && !write_wav(wavpath, (int)(av.timing.sample_rate + 0.5))) return 1;
	fprintf(stderr, "host: %zu sample frames captured (%.2f s)%s%s\n",
	        pcm_len / 2, (double)(pcm_len / 2) / av.timing.sample_rate,
	        wavpath ? " -> " : "", wavpath ? wavpath : "");

	core.unload_game();
	core.deinit();
	return 0;
}
