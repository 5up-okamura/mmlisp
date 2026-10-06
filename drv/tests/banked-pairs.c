#include <assert.h>
#include "mmlpairs.h"
int main(void) {
  MMLPairsCfg cfg = {0x1d00,128,16,0x13,9,0x20,2,2,32,1};
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
