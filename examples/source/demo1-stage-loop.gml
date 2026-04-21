; GMLisp demo 1
; Purpose: loop/marker stability + base/delta modulation
; Structure: A(2bar x2) + B(2bar) = 6-bar loop in C major, 120 BPM

(def fb-init 2)

(score :id :demo1-stage-loop
  :title "Demo 1 Stage Loop"
  :author "okamura"
  :tempo 120

  (track
    :main (phrase :riff (marker :intro)
    
      (param-set :fm-fb fb-init)
    
      (loop-begin :a)
    
      (notes :c4 :e4 :g4 :e4 :c4 :e4 :g4 :e4)
    
      (notes :a3 :c4 :e4 :c4 :a3 :c4 :e4 :c4)
      (param-add :fm-fb +1)
      (loop-end :a 2)
      (param-set :fm-fb fb-init)
    
      (notes :f3 :a3 :c4 :a3 :f3 :a3 :c4 :a3)
    
      (note :g3 1/4)
      (tuplet 1/4 :a3 :b3 :a3)
      (note :c4 1/4)
      (rest 1/4)
    
      (jump :intro)
    )
  )
)
