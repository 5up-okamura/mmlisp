; GMLisp demo 1
; Purpose: loop/marker stability + base/delta modulation
; Structure: A(2bar x2) + B(2bar) = 6-bar loop in C major, 120 BPM

(def fb-init 2)

(def pluck :psg [15 13 11 9 7 5 3 1 0])

(def sustain :psg [:seq 15 :loop 14 13 :release 3])

(def kick-env :psg [15 14 12 9 5 0])

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

  (track :bass
    :ch :psg1

    (phrase :psg-bass (marker :intro)

      (ins sustain)

      (loop-begin :pa)
      (note :c3 1/2)
      (note :c3 1/2)
      (note :c3 1/2)
      (note :c3 1/2)
      (note :a2 1/2)
      (note :a2 1/2)
      (note :a2 1/2)
      (note :a2 1/2)
      (loop-end :pa 2)

      (note :f2 1/2)
      (note :f2 1/2)
      (note :f2 1/2)
      (note :f2 1/2)
      (note :g2 1/4)
      (note :g2 1/4)
      (note :g2 1/4)
      (note :g2 1/4)

      (jump :intro)
    )
  )

  (track :counter
    :ch :psg2

    (phrase :psg-counter (marker :intro)

      (ins pluck)

      (loop-begin :pb)
      (notes :e5 _ :g5 _ :e5 _ :g5 _)
      (notes :c5 _ :e5 _ :c5 _ :e5 _)
      (loop-end :pb 2)

      (notes :a4 _ :c5 _ :a4 _ :c5 _)
      (note :b4 1/4)
      (note :d5 1/4)
      (rest 1/2)

      (jump :intro)
    )
  )

  (track :perc
    :ch :noise

    (phrase :psg-noise (marker :intro)

      (ins kick-env)

      (loop-begin :pn)
      (rest 1/4)
      (note :c4 1/4)
      (rest 1/4)
      (note :c4 1/4)
      (rest 1/4)
      (note :c4 1/4)
      (rest 1/4)
      (note :c4 1/4)
      (rest 1/4)
      (note :c4 1/4)
      (rest 1/4)
      (note :c4 1/4)
      (rest 1/4)
      (note :c4 1/4)
      (rest 1/4)
      (note :c4 1/4)
      (loop-end :pn 3)

      (rest 1/4)
      (note :c4 1/4)
      (rest 1/4)
      (note :c4 1/4)
      (rest 1/4)
      (note :c4 1/4)
      (rest 1/4)
      (note :c4 1/4)

      (jump :intro)
    )
  )
)
