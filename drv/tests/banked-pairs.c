#include <assert.h>
#include "mmlpairs.h"
#include "mmlispseq.h"

static void banked_order(const MMLPairsCfg *cfg) {
  static MMLSeq seq;
  MMLPairs p;
  const MMLWrite writes[] = {
    {0,0x30,1},{0,0x40,2},{0,0x50,3},{0,0x60,4},{0,0x70,5},
    {0,0x80,6},{0,0x90,7},{0,0xb0,8},{0,0xb4,0},
    {1,0xa5,9},{1,0xa1,10},{0,0x28,0xf5},
    {0,0xa5,11},{0,0xa1,12},{0,0x28,0xf1},{2,0,0x90}
  };
  mmlp_init(&p,cfg);
  for (uint8_t ch=0;ch<6;ch++) p.fm_mod[ch]=0;
  seq.q_tail=MML_WRITE_QUEUE-4;
  seq.q_head=(seq.q_tail+16)&(MML_WRITE_QUEUE-1);
  for (uint16_t i=0;i<16;i++) seq.q[(seq.q_tail+i)&(MML_WRITE_QUEUE-1)]=writes[i];
  mmlp_drain(&p,&seq);
  assert(p.q_head==15 && p.psg_head==1 && p.psg[0]==0x90);
  /* Short channel groups precede the nine-write patch, with pitch pairs intact. */
  for (uint16_t i=0;i<15;i++) {
    uint16_t at=i<3 ? 12+i : i<6 ? 9+i-3 : i-6;
    assert(p.q_port[i]==writes[at].port && p.q_op[i]==writes[at].addr
           && p.q_val[i]==writes[at].data);
  }
  mmlp_init(&p,cfg); /* Unknown modulation keeps the original channel order. */
  seq.q_tail=MML_WRITE_QUEUE-4;
  seq.q_head=(seq.q_tail+16)&(MML_WRITE_QUEUE-1);
  mmlp_drain(&p,&seq);
  assert(p.q_head==15);
  for (uint16_t i=0;i<15;i++)
    assert(p.q_port[i]==writes[i].port && p.q_op[i]==writes[i].addr
           && p.q_val[i]==writes[i].data);
}
int main(void) {
  MMLPairsCfg cfg = {0x1d00,128,16,0x13,9,0x20,2,2,32,1};
  banked_order(&cfg);
  MMLPairs p;
  uint8_t ops[32], vals[32]; uint16_t dst;
  mmlp_init(&p,&cfg);
  p.q_head=2; p.q_op[0]=0x30; p.q_op[1]=0x31;
  p.frames_in=1; p.end_q[0]=2;
  p.head=10; p.head_valid=1; p.last_fifo=40;
  assert(mmlp_plan(&p,40,1,ops,vals,&dst)==0);
  assert(p.q_tail==0); /* Even a two-pair plan physically writes 16 cells. */
  mmlp_init(&p,&cfg);
  p.q_head=1; p.q_op[0]=0x30; p.frames_in=1; p.end_q[0]=1;
  p.head=16; p.head_valid=1; p.last_fifo=0;
  assert(mmlp_plan(&p,40,1,ops,vals,&dst)==1);
  assert(dst==0x1d00+2*(20+32)); /* Consumer passed the old head. */
  mmlp_init(&p,&cfg);
  /* Two generation changes with no staged byte between them still need a fence. */
  p.q_head=2; p.q_port[0]=p.q_port[1]=0xff;
  p.q_op[0]=p.q_op[1]=8; p.q_val[0]=1; p.q_val[1]=2;
  p.frames_in=1; p.end_q[0]=2;
  assert(mmlp_plan(&p,0,1,ops,vals,&dst)==4);
  assert(ops[0]==8 && ops[1]==0 && ops[2]==0 && ops[3]==8);
  mmlp_init(&p,&cfg);
  p.q_head=1; p.q_op[0]=0x30; p.frames_in=1; p.end_q[0]=1;
  p.head=114; p.head_valid=1; p.last_fifo=0;
  assert(mmlp_plan(&p,0,1,ops,vals,&dst)==0);
  assert(p.head==114 && p.head_valid && p.q_tail==0);
  mmlp_init(&p,&cfg);
  p.q_head=1; p.q_op[0]=0x30; p.frames_in=1; p.end_q[0]=1;
  p.head=80; p.head_valid=1; p.last_fifo=20;
  assert(mmlp_plan(&p,20,1,ops,vals,&dst)==1);
  mmlp_abort(&p);
  assert(p.head==80 && p.head_valid && p.q_tail==0);
  cfg.voices=3;
  mmlp_init(&p,&cfg);
  uint8_t note[] = {1,6,2,0,0,0x81,0x10,0x81,0,0xff,128,0};
  mmlp_frame(&p,note,sizeof(note));
  assert(p.fault==1 && p.q_head==0 && p.start_gen[2]==0);
  note[10]=127;
  mmlp_frame(&p,note,sizeof(note));
  assert(p.q_head==9 && p.q_op[7]==0x21 && p.q_val[7]==127 && p.q_op[8]==26);
  return 0;
}
